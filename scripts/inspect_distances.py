#!/usr/bin/env python3
"""
파이프라인이 내부적으로 계산하는 값들(거리행렬, DTW 정렬, 실루엣/knn 검증)을
사람이 눈으로 볼 수 있는 파일로 저장한다.

지금까지 run_pipeline.py는 viz/app.js가 그림을 그리는 데 필요한 최종 JSON만
만들었고, "거리행렬 원본 숫자", "두 trace가 실제로 어떻게 정렬됐는지"는
어디에도 저장되지 않았다. 이 스크립트는 그 중간 계산 결과를 그대로 꺼내서
analysis_output/<suite>/ 아래에 CSV/Markdown으로 남긴다.

    python scripts/inspect_distances.py --suite banking
    python scripts/inspect_distances.py --suite banking --pair-a case_0 --pair-b case_1

만든다:
  analysis_output/<suite>/distance_matrix_raw.csv       거리행렬 (raw)
  analysis_output/<suite>/distance_matrix_residual.csv  거리행렬 (residual)
  analysis_output/<suite>/nearest_neighbors.md          케이스별 가장 가까운/먼 상대
  analysis_output/<suite>/dtw_alignment_example.md      두 trace 사이 DTW 정렬을 한 스텝씩 펼친 표
  analysis_output/<suite>/validation.md                 라벨별 실루엣 계수 + 순열검정 p-value
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np

from pipeline.diagnostics import knn_isolation
from pipeline.distances import compute_suite_distances
from pipeline.dtw import dtw_distance
from pipeline.gt_align import DEFAULT_TAU, calibrate_tau
from pipeline.schema import trace_from_dict
from pipeline.validate import validate_suite
from pipeline.vectorize import Embedder, collect_corpus, serialize_event, vectorize_ground_truth, vectorize_trace


def write_distance_matrix_csv(path: Path, case_ids: list[str], matrix: np.ndarray) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([""] + case_ids)
        for i, cid in enumerate(case_ids):
            writer.writerow([cid] + [f"{v:.4f}" for v in matrix[i]])


def write_nearest_neighbors_md(path: Path, case_ids: list[str], matrix: np.ndarray, k: int = 3) -> None:
    lines = ["# 케이스별 최근접/최원접 이웃 (raw distance 기준)\n"]
    n = len(case_ids)
    for i, cid in enumerate(case_ids):
        row = matrix[i].copy()
        row[i] = np.inf
        order = np.argsort(row)
        nearest = [(case_ids[j], row[j]) for j in order[:k]]
        row[i] = -np.inf
        order_far = np.argsort(-matrix[i])
        # 자기 자신 제외한 가장 먼 것들
        farthest = [(case_ids[j], matrix[i][j]) for j in order_far if j != i][:k]
        lines.append(f"## {cid}")
        lines.append("가장 가까움: " + ", ".join(f"{c}({d:.3f})" for c, d in nearest))
        lines.append("가장 멂: " + ", ".join(f"{c}({d:.3f})" for c, d in farthest))
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_alignment_md(path: Path, case_a: str, case_b: str, events_a, events_b, vec_a, vec_b) -> None:
    result = dtw_distance(vec_a, vec_b)
    lines = [
        f"# DTW 정렬 예시: {case_a} vs {case_b}",
        "",
        f"최종 거리(경로 길이로 정규화됨): **{result.distance:.4f}**",
        f"정렬 경로 길이: {len(result.path)} 스텝 (원본 길이: {case_a}={len(events_a)}, {case_b}={len(events_b)})",
        "",
        "| step | a_idx | a_event | b_idx | b_event | local_cosine_dist |",
        "|---|---|---|---|---|---|",
    ]
    for step, (ai, bi) in enumerate(result.path):
        a_text = serialize_event(events_a[ai]).replace("|", "\\|")
        b_text = serialize_event(events_b[bi]).replace("|", "\\|")
        local_cost = result.cost_matrix[ai, bi]
        lines.append(f"| {step} | {ai} | {a_text} | {bi} | {b_text} | {local_cost:.4f} |")
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def write_validation_md(path: Path, validation: dict) -> None:
    lines = ["# 라벨별 실루엣 계수 + 순열검정 p-value", "",
              "실루엣이 높고 p-value가 낮을수록 '그 라벨대로 그룹을 나누면 거리행렬 상에서 실제로 잘 갈라진다'는 뜻.",
              "", "| label field | raw silhouette | raw p-value | residual silhouette | residual p-value |",
              "|---|---|---|---|---|"]
    for field in validation["raw"]:
        rs = validation["raw"][field]
        rp = validation["raw_pvalue"][field]
        cs = validation["residual"][field]
        cp = validation["residual_pvalue"][field]
        fmt = lambda v: "n/a" if v is None else f"{v:.4f}"
        lines.append(f"| {field} | {fmt(rs)} | {fmt(rp)} | {fmt(cs)} | {fmt(cp)} |")
    path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", default="data/traces.json")
    parser.add_argument("--suite", required=True, help="예: banking / slack / travel / workspace")
    parser.add_argument("--outdir", default="analysis_output")
    parser.add_argument("--pair-a", default=None, help="정렬 예시로 볼 케이스 A (기본: 서로 가장 먼 쌍을 자동 선택)")
    parser.add_argument("--pair-b", default=None, help="정렬 예시로 볼 케이스 B")
    parser.add_argument("--tau", type=float, default=None)
    parser.add_argument("--flag-weight", type=float, default=0.5)
    args = parser.parse_args()

    with open(args.input, encoding="utf-8") as f:
        raw = json.load(f)
    all_traces = [trace_from_dict(d) for d in raw]
    traces = [t for t in all_traces if t.suite == args.suite]
    if not traces:
        raise SystemExit(f"suite '{args.suite}'에 해당하는 trace가 없습니다.")

    embedder = Embedder()
    embedder.fit(collect_corpus(all_traces))
    print(f"[embedder] backend = {embedder.backend}")

    vtraces = [vectorize_trace(t, embedder, flag_weight=args.flag_weight) for t in traces]

    gt_cache: dict[tuple, np.ndarray] = {}
    gt_vectors_by_case: dict[str, np.ndarray] = {}
    for t in traces:
        key = tuple(t.ground_truth)
        if key not in gt_cache:
            gt_cache[key] = vectorize_ground_truth(list(key), embedder)
        gt_vectors_by_case[t.case_id] = gt_cache[key]

    tau = args.tau if args.tau is not None else calibrate_tau(vtraces, gt_vectors_by_case, default=DEFAULT_TAU)
    print(f"[tau] {tau:.4f}")

    dist = compute_suite_distances(vtraces, gt_vectors_by_case, tau=tau)
    validation = validate_suite(traces, dist.raw_matrix, dist.residual_matrix)
    raw_knn, raw_pct, k = knn_isolation(dist.raw_matrix, k=5)

    outdir = Path(args.outdir) / args.suite
    outdir.mkdir(parents=True, exist_ok=True)

    write_distance_matrix_csv(outdir / "distance_matrix_raw.csv", dist.case_ids, dist.raw_matrix)
    write_distance_matrix_csv(outdir / "distance_matrix_residual.csv", dist.case_ids, dist.residual_matrix)
    write_nearest_neighbors_md(outdir / "nearest_neighbors.md", dist.case_ids, dist.raw_matrix)
    write_validation_md(outdir / "validation.md", validation)

    # knn 고립도까지 CSV로 저장 (군집 밖으로 튀어나온 후보를 눈으로 찾을 때 씀)
    with open(outdir / "knn_isolation.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["case_id", "mean_knn_distance", "isolation_percentile"])
        for cid, d, p in zip(dist.case_ids, raw_knn, raw_pct):
            writer.writerow([cid, f"{d:.4f}", f"{p:.4f}"])

    # 정렬 예시: 지정 안 하면 raw 거리행렬에서 가장 먼 쌍을 자동으로 고른다
    case_ids = dist.case_ids
    if args.pair_a and args.pair_b:
        ia, ib = case_ids.index(args.pair_a), case_ids.index(args.pair_b)
    else:
        ia, ib = np.unravel_index(np.argmax(dist.raw_matrix), dist.raw_matrix.shape)
    ca, cb = case_ids[ia], case_ids[ib]
    vt_by_case = {vt.trace.case_id: vt for vt in vtraces}
    t_by_case = {t.case_id: t for t in traces}
    write_alignment_md(
        outdir / "dtw_alignment_example.md", ca, cb,
        t_by_case[ca].events, t_by_case[cb].events,
        vt_by_case[ca].vectors, vt_by_case[cb].vectors,
    )

    print(f"완료 -> {outdir}/ 에 5개 파일 저장 (정렬 예시 쌍: {ca} vs {cb})")


if __name__ == "__main__":
    main()
