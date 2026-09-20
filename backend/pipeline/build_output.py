"""
한 suite에 대해 vectorize → gt_align → distances → reduce → validate 를 실행하고,
프론트엔드(viz/app.js)가 바로 fetch해서 그릴 수 있는 JSON 하나로 조립한다.

출력 JSON 구조는 README.md의 "데이터 포맷" 절에 문서화되어 있다.
"""

from __future__ import annotations

from dataclasses import asdict

import numpy as np

from .cluster import cluster_agreement, cluster_distance_matrix, compute_medoids, select_k_by_silhouette
from .distances import compute_suite_distances
from .diagnostics import knn_isolation
from .reduce import project_2d
from .schema import Trace
from .validate import LABEL_FIELDS, validate_suite
from .vectorize import Embedder, vectorize_ground_truth, vectorize_trace
from .gt_align import DEFAULT_TAU, calibrate_tau
from .security_analysis import build_security_analysis


def _event_to_dict(ev, matched: bool, gt_index) -> dict:
    return {
        "index": ev.index,
        "role": ev.role,
        "function": ev.function,
        "args": ev.args,
        "text": ev.text,
        "injected": ev.injected,
        "matched_to_gt": matched,
        "gt_index": gt_index,
    }


def build_suite_output(
    suite_name: str,
    traces: list[Trace],
    embedder: Embedder,
    flag_weight: float = 0.5,
    tau: float | None = None,
    residual_mode: str = "all",
    seed: int = 42,
    n_clusters: int | None = None,
) -> dict:
    vtraces = [vectorize_trace(t, embedder, flag_weight=flag_weight) for t in traces]

    # 케이스별 GT 벡터는 ground_truth 목록이 같으면 재사용 (같은 suite면 보통 전부 동일)
    gt_cache: dict[tuple, np.ndarray] = {}
    gt_vectors_by_case: dict[str, np.ndarray] = {}
    for t in traces:
        key = tuple(t.ground_truth)
        if key not in gt_cache:
            gt_cache[key] = vectorize_ground_truth(list(key), embedder)
        gt_vectors_by_case[t.case_id] = gt_cache[key]

    tau_auto = tau is None
    resolved_tau = calibrate_tau(vtraces, gt_vectors_by_case, default=DEFAULT_TAU) if tau_auto else tau

    dist = compute_suite_distances(vtraces, gt_vectors_by_case, tau=resolved_tau, residual_mode=residual_mode)

    coords_raw, n_neighbors_raw = project_2d(dist.raw_matrix, seed=seed)
    coords_residual, n_neighbors_residual = project_2d(dist.residual_matrix, seed=seed)

    validation = validate_suite(traces, dist.raw_matrix, dist.residual_matrix)

    raw_knn, raw_isolation_pct, raw_knn_k = knn_isolation(dist.raw_matrix, k=5)
    res_knn, res_isolation_pct, res_knn_k = knn_isolation(dist.residual_matrix, k=5)

    # 계층적 군집화(cluster.py) — raw/residual 거리행렬 각각에 독립적으로 적용.
    # UMAP 좌표(coords_raw/residual)는 시각화용 차원축소일 뿐 군집을 나눠주지
    # 않으므로, "라벨 없이 거리만 보고 그룹을 나누는" 이 단계가 따로 필요하다.
    # n_clusters를 명시하지 않으면(기본) 예전처럼 6으로 고정하지 않고, 라벨을 전혀
    # 쓰지 않는 실루엣 기준 k-스윕(pipeline_study의 최신 실험 반영, cluster.py의
    # select_k_by_silhouette 참고)으로 raw/residual 공간마다 독립적으로 k를 고른다.
    if n_clusters is None:
        raw_k, raw_k_sweep = select_k_by_silhouette(dist.raw_matrix)
        res_k, res_k_sweep = select_k_by_silhouette(dist.residual_matrix)
    else:
        raw_k = res_k = min(n_clusters, len(traces)) if traces else 0
        raw_k_sweep = res_k_sweep = []
    raw_cluster = cluster_distance_matrix(dist.raw_matrix, k=raw_k)
    res_cluster = cluster_distance_matrix(dist.residual_matrix, k=res_k)

    vt_by_case = {vt.trace.case_id: vt for vt in vtraces}

    cases = []
    for i, t in enumerate(traces):
        matched = dist.matched_to_gt[t.case_id]
        gt_idx = dist.gt_index_of_event[t.case_id]
        cases.append({
            "case_id": t.case_id,
            "pair_key": t.pair_key,
            "condition": t.condition,
            "model": t.model,
            "user_task_id": t.user_task_id,
            "injection_task_id": t.injection_task_id,
            "utility": t.utility,
            "security": t.security,
            "verdict": t.verdict,
            "hijack_tool": t.hijack_tool,
            "exposure_channel": t.exposure_channel,
            "delay": t.delay,
            "delay_bucket": t.delay_bucket,
            "residual_length": dist.residual_lengths[i],
            "n_events": len(t.events),
            "coords_raw": coords_raw[i].tolist(),
            "coords_residual": coords_residual[i].tolist(),
            "raw_knn_distance": float(raw_knn[i]),
            "raw_isolation_percentile": float(raw_isolation_pct[i]),
            "residual_knn_distance": float(res_knn[i]),
            "residual_isolation_percentile": float(res_isolation_pct[i]),
            "cluster_raw": raw_cluster.labels[i] if raw_cluster.labels else None,
            "cluster_residual": res_cluster.labels[i] if res_cluster.labels else None,
            "ground_truth": t.ground_truth,
            "injection_exposure": t.injection_exposure,
            "hijack_events": t.hijack_events,
            "first_deviation": t.first_deviation,
            "events": [_event_to_dict(ev, matched[k], gt_idx[k]) for k, ev in enumerate(t.events)],
        })

    security_analysis = build_security_analysis(cases)
    arrows = _build_arrows(cases, vt_by_case)

    # 군집 결과가 실제로 의미 있는지: 이미 아는 라벨(hijack_tool 등)과 ARI/NMI로 비교.
    # 순도(purity)는 군집 크기가 불균등하면 왜곡되기 쉬워(작은 군집이 착시적으로
    # 순도를 끌어올림) 쓰지 않고, 우연을 보정하는 ARI/NMI만 남긴다.
    cluster_validation = {"raw": {}, "residual": {}}
    for field in LABEL_FIELDS:
        ref = [getattr(t, field) for t in traces]
        cluster_validation["raw"][field] = cluster_agreement(raw_cluster.labels, ref)
        cluster_validation["residual"][field] = cluster_agreement(res_cluster.labels, ref)

    hijack_tools = [t.hijack_tool for t in traces]
    cluster_medoids = {
        "raw": compute_medoids(dist.raw_matrix, dist.case_ids, raw_cluster.labels, hijack_tools),
        "residual": compute_medoids(dist.residual_matrix, dist.case_ids, res_cluster.labels, hijack_tools),
    }

    return {
        "suite": suite_name,
        "params": {"flag_weight": flag_weight, "tau": resolved_tau, "tau_auto_calibrated": tau_auto,
                   "residual_mode": residual_mode, "embedding_backend": embedder.backend, "seed": seed,
                   "n_clusters_raw": raw_k, "n_clusters_residual": res_k,
                   "n_clusters_auto": n_clusters is None,
                   "n_neighbors_raw": n_neighbors_raw, "n_neighbors_residual": n_neighbors_residual},
        "case_ids": dist.case_ids,
        "cases": cases,
        "validation": validation,
        "cluster_validation": cluster_validation,
        "cluster_medoids": cluster_medoids,
        "cluster_k_sweep": {"raw": raw_k_sweep, "residual": res_k_sweep},
        "distance_diagnostics": {"raw_knn_k": raw_knn_k, "residual_knn_k": res_knn_k},
        "security_analysis": security_analysis,
        "arrows": arrows,
        # 케이스간 직접 DTW 거리 행렬 — "각 트레이스 간 거리를 눈으로 볼 수 없다"는
        # 문제에 대한 답. dist.case_ids 순서와 1:1 대응하며, 화면에서는 계층적
        # 군집화의 병합 순서(merge_log)로 행/열을 재정렬해 클러스터 히트맵으로 그린다.
        "distance_matrix": {
            "case_order": dist.case_ids,
            "raw": dist.raw_matrix.round(4).tolist(),
            "residual": dist.residual_matrix.round(4).tolist(),
            "raw_merge_log": raw_cluster.merge_log.tolist(),
            "residual_merge_log": res_cluster.merge_log.tolist(),
        },
    }


def _build_arrows(cases: list[dict], vt_by_case: dict) -> list[dict]:
    """같은 pair_key(같은 user_task x injection_task)를 가진 두 조건을 이어
    A→B 화살표 지도(PDF 그림 7, 10)의 재료로 만든다. 조건이 3개 이상이면
    조건 이름을 알파벳/문자열 순으로 정렬해 인접한 두 개씩 잇는다.
    동시에 A↔B 이벤트 시퀀스를 직접 DTW로 정렬한 경로도 함께 저장해서,
    프론트엔드의 3자 정렬 뷰(GT/A/B)에서 A-B 줄 사이 연결선을 그릴 수 있게 한다."""
    from .dtw import dtw_distance  # 지연 임포트로 순환 참조 방지

    by_pair: dict[str, list[dict]] = {}
    for c in cases:
        by_pair.setdefault(c["pair_key"], []).append(c)

    arrows = []
    for pair_key, group in by_pair.items():
        group_sorted = sorted(group, key=lambda c: c["condition"])
        for a, b in zip(group_sorted, group_sorted[1:]):
            vt_a, vt_b = vt_by_case[a["case_id"]], vt_by_case[b["case_id"]]
            ab_align = dtw_distance(vt_a.vectors, vt_b.vectors)
            arrows.append({
                "pair_key": pair_key,
                "from_case_id": a["case_id"],
                "to_case_id": b["case_id"],
                "from_condition": a["condition"],
                "to_condition": b["condition"],
                "from_raw": a["coords_raw"],
                "to_raw": b["coords_raw"],
                "from_residual": a["coords_residual"],
                "to_residual": b["coords_residual"],
                "from_verdict": a["verdict"],
                "to_verdict": b["verdict"],
                "newly_hijacked": (not a["security"]) and b["security"],
                "newly_blocked": a["security"] and (not b["security"]),
                "a_to_b_alignment": [[int(i), int(j)] for i, j in ab_align.path],
            })
    return arrows
