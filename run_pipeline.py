#!/usr/bin/env python3
"""
DojoScope trace embedding 파이프라인 — 데이터셋 전체를 처음부터 다시 계산한다.

    python run_pipeline.py --input data/sample/traces.json --outdir viz/data

입력 JSON은 pipeline.schema.Trace 목록 (scripts/generate_sample_data.py 출력 형식).
suite별로 하나씩 JSON을 --outdir(기본 viz/data)에 만들고, viz/index.html이
그 파일들을 정적으로 fetch한다.

데이터를 새로 몇 건 추가하는 정도라면 이 스크립트보다 `add_data.py`가 더 편하다
(기존 데이터와 자동으로 병합해준다). 이 스크립트는 데이터셋 전체를 처음부터
다시 계산하고 싶을 때(설정값을 바꿔서 재실험할 때, CI 등) 쓴다.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from pipeline.orchestrate import compute_all_suites
from pipeline.schema import trace_from_dict


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", default="data/sample/traces.json", help="입력 trace JSON 경로")
    parser.add_argument("--outdir", default="viz/data", help="suite별 출력 JSON을 저장할 디렉터리 (기본: 정적 화면이 읽는 viz/data)")
    parser.add_argument("--flag-weight", type=float, default=0.5, help="구조 플래그 가중치 (PDF 기본값 0.5)")
    parser.add_argument("--tau", type=float, default=None,
                         help="GT 매칭 임계값. 지정하지 않으면(기본) suite·임베딩 백엔드에 맞춰 "
                              "자동 보정(calibrate_tau)한다. PDF 원문 값을 강제하려면 --tau 0.35로 지정.")
    parser.add_argument("--residual-mode", choices=["all", "tool_calls"], default="all",
                         help="'tool_calls'면 잔차 중 도구 호출 이벤트만 남기고 DTW를 잰다 (PDF 8장 조정안 1)")
    parser.add_argument("--model", default="BAAI/bge-small-en-v1.5", help="sentence-transformers 모델명")
    parser.add_argument("--seed", type=int, default=42, help="UMAP 재현용 시드")
    parser.add_argument("--n-clusters", type=int, default=6,
                         help="계층적 군집화(cluster.py)로 나눌 군집 개수 (기본 6). "
                              "suite 케이스 수보다 크면 자동으로 줄어든다.")
    args = parser.parse_args()

    t0 = time.time()

    with open(args.input, encoding="utf-8") as f:
        raw_cases = json.load(f)
    traces = [trace_from_dict(d) for d in raw_cases]

    outputs, backend = compute_all_suites(
        traces, flag_weight=args.flag_weight, tau=args.tau,
        residual_mode=args.residual_mode, model_name=args.model, seed=args.seed,
        n_clusters=args.n_clusters,
    )
    print(f"[embedder] backend = {backend}")

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "suites": [],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "embedding_backend": backend,
        "case_count": len(traces),
        "params": vars(args),
    }
    for suite_name, output in outputs.items():
        out_path = outdir / f"{suite_name}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False)
        manifest["suites"].append(suite_name)
        tau_note = "자동보정" if output["params"]["tau_auto_calibrated"] else "수동지정"
        print(f"[{suite_name}] {len(output['cases'])} cases · tau={output['params']['tau']:.3f} ({tau_note})")
        print(f"  -> {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")

    with open(outdir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"완료. 총 {len(traces)}건, {time.time() - t0:.1f}초")


if __name__ == "__main__":
    main()
