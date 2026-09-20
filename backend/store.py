"""
서버 프로세스 안에서 유지되는 "현재 데이터셋" 상태.

add_data.py의 병합·재계산 로직을 그대로 가져오되, 결과를 디스크(JSON 파일)가
아니라 메모리에도 함께 들고 있어서(traces, embedder) /api/compare 같은
온디맨드 계산(임의의 두 케이스를 즉석에서 DTW로 비교)에 재사용할 수 있게 한다.

디스크에도 현재 데이터셋(raw dict 목록)을 저장해 서버 재시작 시 복원한다.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from pipeline.orchestrate import compute_all_suites
from pipeline.schema import Trace, trace_from_dict
from pipeline.vectorize import Embedder, collect_corpus

BASE_DIR = Path(__file__).resolve().parent
SAMPLE_PATH = BASE_DIR / "data" / "sample_traces.json"
CURRENT_PATH = BASE_DIR / "data" / "current_traces.json"


def _case_key(d: dict) -> str:
    return f"{d.get('suite')}__{d.get('user_task_id')}__{d.get('injection_task_id')}__{d.get('condition')}"


class Store:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.raw_cases: list[dict] = []
        self.traces: list[Trace] = []
        self.traces_by_case_id: dict[str, Trace] = {}
        self.outputs: dict[str, dict] = {}
        self.embedder: Embedder | None = None
        self.manifest: dict = {"suites": [], "generated_at": None, "embedding_backend": None, "case_count": 0}

    # ------------------------------------------------------------------
    def startup(self) -> None:
        # 이전에 업로드해서 저장해 둔 데이터가 있으면 그걸 복원하고, 전혀 없으면
        # (한 번도 업로드한 적 없는 첫 실행) 샘플 데이터를 자동으로 채우지 않고
        # 빈 상태로 띄운다 — "업로드하기 전엔 아무것도 없다가, 올리면 바로
        # 반영"되어야 한다는 요구사항. 샘플 데이터는 화면의 "샘플로 초기화"
        # 버튼(/api/reset)으로 원할 때만 명시적으로 불러온다.
        if CURRENT_PATH.exists():
            with open(CURRENT_PATH, encoding="utf-8") as f:
                cases = json.load(f)
            print(f"[store] 초기 데이터 로드: current_traces.json ({len(cases)}건)")
            self.recompute(cases, persist=False)
        else:
            print("[store] 저장된 데이터 없음 - 빈 상태로 시작. 업로드하거나 '샘플로 초기화'를 눌러주세요.")
            self.recompute([], persist=False)

    def reset_to_sample(self) -> dict:
        with open(SAMPLE_PATH, encoding="utf-8") as f:
            cases = json.load(f)
        return self.recompute(cases, persist=True)

    def merge_and_recompute(self, new_cases: list[dict]) -> dict:
        # 스키마 검증부터: 하나라도 형식이 틀리면 전체를 거부한다.
        for d in new_cases:
            trace_from_dict(d)

        with self._lock:
            existing = list(self.raw_cases)
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
        result = self.recompute(existing, persist=True)
        result["merge"] = {"added": added, "replaced": replaced, "total": len(existing)}
        return result

    def recompute(self, raw_cases: list[dict], persist: bool) -> dict:
        t0 = time.time()
        traces = [trace_from_dict(d) for d in raw_cases]

        if not traces:
            # 빈 데이터셋: Embedder.fit([])은 코퍼스가 비어 TF-IDF가 어휘를 만들지
            # 못해 예외를 던진다 — 애초에 계산할 게 없으므로 빈 상태로 바로 반환.
            embedder = None
            outputs: dict[str, dict] = {}
            backend = None
        else:
            embedder = Embedder()
            embedder.fit(collect_corpus(traces))
            outputs, backend = compute_all_suites(traces)

        manifest = {
            "suites": sorted(outputs.keys()),
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "embedding_backend": backend,
            "case_count": len(traces),
            "compute_seconds": round(time.time() - t0, 2),
        }

        with self._lock:
            self.raw_cases = raw_cases
            self.traces = traces
            self.traces_by_case_id = {t.case_id: t for t in traces}
            self.outputs = outputs
            self.embedder = embedder
            self.manifest = manifest

        if persist:
            CURRENT_PATH.parent.mkdir(parents=True, exist_ok=True)
            with open(CURRENT_PATH, "w", encoding="utf-8") as f:
                json.dump(raw_cases, f, ensure_ascii=False)

        print(f"[store] 재계산 완료: {len(traces)}건, 임베딩={backend}, {manifest['compute_seconds']}s")
        return manifest

    # ------------------------------------------------------------------
    def get_manifest(self) -> dict:
        with self._lock:
            return dict(self.manifest)

    def get_suite(self, name: str) -> dict | None:
        with self._lock:
            return self.outputs.get(name)

    def get_trace(self, case_id: str) -> Trace | None:
        with self._lock:
            return self.traces_by_case_id.get(case_id)

    def get_embedder(self) -> Embedder | None:
        with self._lock:
            return self.embedder


store = Store()
