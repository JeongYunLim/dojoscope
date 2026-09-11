#!/usr/bin/env python3
"""
정적 대시보드(viz/)에 새 trace 데이터를 추가하고 즉시 반영되도록 만드는 스크립트.

    python add_data.py 새파일.json     # 새파일.json의 케이스를 현재 데이터에 합쳐서 재계산
    python add_data.py --reset          # 샘플 데이터(192건)로 초기화하고 재계산
    python add_data.py --rebuild        # 병합 없이 지금 data/traces.json 그대로 재계산만

동작 방식:
  1. data/traces.json(현재까지 누적된 전체 데이터셋)을 읽는다. 없으면
     data/sample/traces.json을 기준으로 새로 만든다.
  2. 새파일.json의 케이스들을 (suite, user_task_id, injection_task_id, condition)
     키로 병합한다 — 같은 키가 있으면 덮어쓰고, 없으면 추가한다.
  3. 병합된 전체 데이터셋을 data/traces.json에 다시 저장한다 (다음에 또
     add_data.py를 실행하면 이번에 추가한 것까지 포함해서 계속 누적된다).
  4. 전체 데이터셋에 대해 파이프라인(임베딩→DTW→GT정렬/잔차→UMAP→검증)을
     다시 돌려서 viz/data/<suite>.json + viz/data/manifest.json을 새로 쓴다.
     viz/index.html은 이 폴더를 정적으로 fetch하므로, 브라우저를
     새로고침(F5)하면 바로 반영된다. 서버 재시작은 필요 없다.

새파일.json 형식은 data/sample/traces.json과 같다 — pipeline/schema.py의
Trace/Event 형식을 따르는 케이스들의 JSON 배열, 또는 {"cases": [...]}.
자세한 필드 설명은 README.md의 "데이터 포맷" 절을 참고할 것.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

from pipeline.orchestrate import compute_all_suites
from pipeline.schema import trace_from_dict
from scripts.generate_sample_data import N_INJECTION_TASKS, N_USER_TASKS, SUITES, build_case

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "traces.json"
SAMPLE_PATH = BASE_DIR / "data" / "sample" / "traces.json"
OUT_DIR = BASE_DIR / "viz" / "data"


def _case_key(d: dict) -> str:
    return f"{d.get('suite')}__{d.get('user_task_id')}__{d.get('injection_task_id')}__{d.get('condition')}"


def _generate_sample_cases() -> list[dict]:
    """scripts/generate_sample_data.py의 main()과 동일한 절차."""
    random.seed(7)
    cases = []
    for suite_name, cfg in SUITES.items():
        for u in range(N_USER_TASKS):
            for i in range(N_INJECTION_TASKS):
                for condition in ("A", "B"):
                    cases.append(build_case(suite_name, cfg, f"user_task_{u}", f"injection_task_{i}", condition))
    return cases


def _load_current_dataset() -> list[dict]:
    if DATA_PATH.exists():
        with open(DATA_PATH, encoding="utf-8") as f:
            return json.load(f)
    if SAMPLE_PATH.exists():
        print(f"[add_data] {DATA_PATH.name}이 없어 {SAMPLE_PATH}를 기준으로 시작합니다.")
        with open(SAMPLE_PATH, encoding="utf-8") as f:
            return json.load(f)
    print("[add_data] 기존 데이터가 전혀 없어 빈 데이터셋에서 시작합니다.")
    return []


def _merge(existing: list[dict], new_cases: list[dict]) -> tuple[list[dict], int, int]:
    index_by_key = {_case_key(d): i for i, d in enumerate(existing)}
    added, replaced = 0, 0
    for d in new_cases:
        key = _case_key(d)
        if key in index_by_key:
            existing[index_by_key[key]] = d
            replaced += 1
        else:
            existing.append(d)
            index_by_key[key] = len(existing) - 1
            added += 1
    return existing, added, replaced


def _recompute_and_write(raw_cases: list[dict]) -> None:
    traces = [trace_from_dict(d) for d in raw_cases]  # 여기서 스키마 오류가 있으면 바로 예외로 드러남

    t0 = time.time()
    print(f"[add_data] 재계산 시작 ({len(traces)}건) — 처음 돌릴 땐 UMAP 라이브러리 최초 컴파일 때문에 "
          f"평소보다 오래 걸릴 수 있습니다.")

    def _log_progress(msg: str):
        print(f"[add_data]   ({time.time() - t0:.1f}s) {msg}")

    outputs, backend = compute_all_suites(traces, on_progress=_log_progress)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "suites": sorted(outputs.keys()),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "embedding_backend": backend,
        "case_count": len(traces),
    }
    for name, output in outputs.items():
        with open(OUT_DIR / f"{name}.json", "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False)
    with open(OUT_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(raw_cases, f, ensure_ascii=False)

    print(f"[add_data] 완료 ({time.time() - t0:.1f}초). 총 {len(traces)}건, "
          f"임베딩={backend}. {OUT_DIR}/ 에 반영했습니다 — 브라우저를 새로고침(F5)하세요.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("input_file", nargs="?", help="추가할 케이스가 담긴 JSON 파일 경로")
    group.add_argument("--reset", action="store_true", help="샘플 데이터(192건)로 초기화하고 재계산")
    group.add_argument("--rebuild", action="store_true", help="병합 없이 지금 data/traces.json 그대로 재계산만")
    args = parser.parse_args()

    if args.reset:
        cases = _generate_sample_cases()
        print(f"[add_data] 샘플 데이터로 초기화합니다 ({len(cases)}건).")
        _recompute_and_write(cases)
        return

    if args.rebuild:
        cases = _load_current_dataset()
        _recompute_and_write(cases)
        return

    if not args.input_file:
        parser.print_help()
        sys.exit(1)

    input_path = Path(args.input_file)
    if not input_path.exists():
        print(f"[add_data] 오류: 파일을 찾을 수 없습니다: {input_path}")
        sys.exit(1)

    with open(input_path, encoding="utf-8") as f:
        payload = json.load(f)
    new_cases = payload.get("cases") if isinstance(payload, dict) else payload
    if not isinstance(new_cases, list) or not new_cases:
        print("[add_data] 오류: 파일 내용이 trace 배열(JSON list, 최소 1건)이 아닙니다.")
        sys.exit(1)

    # 스키마 검증부터 — 하나라도 형식이 틀리면 전체를 거부한다.
    try:
        for d in new_cases:
            trace_from_dict(d)
    except Exception as e:  # noqa: BLE001
        print(f"[add_data] 오류: trace 형식이 잘못됐습니다: {e}")
        print("README.md의 '데이터 포맷' 절을 참고하세요.")
        sys.exit(1)

    existing = _load_current_dataset()
    merged, added, replaced = _merge(existing, new_cases)
    print(f"[add_data] 병합 결과: 새로 추가 {added}건, 기존 갱신 {replaced}건 (전체 {len(merged)}건)")
    _recompute_and_write(merged)


if __name__ == "__main__":
    main()
