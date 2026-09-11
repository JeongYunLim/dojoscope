"""
같은 suite 안에 있는 모든 케이스 쌍에 대해 DTW 거리를 계산한다 (PDF 2단계 후반부,
"비교 범위: 거리는 같은 suite 안에서만 잰다").

두 버전을 모두 계산한다:
  - raw:      이벤트 전체 시퀀스 그대로
  - residual: gt_align으로 뽑아낸, GT와 매칭되지 않은 이벤트만 남긴 시퀀스
              (PDF 4단계, "함정"을 피하기 위한 핵심 아이디어)

residual_mode="tool_calls"를 주면 잔차 중에서도 tool_call role만 남긴다.
PDF 8장 "다음 조정" 1번 제안("잔차 시퀀스에서 도구 호출 이벤트만 남기고 DTW를
다시 잰다")을 그대로 옵션화한 것이다.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .dtw import dtw_distance
from .gt_align import DEFAULT_TAU, align_to_ground_truth
from .vectorize import VectorizedTrace


@dataclass
class SuiteDistances:
    case_ids: list[str]
    raw_matrix: np.ndarray          # (n, n)
    residual_matrix: np.ndarray     # (n, n)
    residual_lengths: list[int]     # 케이스별 잔차 이벤트 개수 (지도 위 점 크기 인코딩에 사용)
    matched_to_gt: dict[str, list[bool]]  # case_id -> 이벤트별 매칭 여부 (프론트 정렬 뷰용)
    gt_index_of_event: dict[str, list[int | None]]  # case_id -> 이벤트별 매칭된 GT 인덱스


def _residual_vectors(vt: VectorizedTrace, matched: list[bool], residual_mode: str) -> tuple[np.ndarray, list[int]]:
    idxs = [i for i, m in enumerate(matched) if not m]
    if residual_mode == "tool_calls":
        idxs = [i for i in idxs if vt.trace.events[i].role == "tool_call"]
    if not idxs:
        return np.zeros((0, vt.vectors.shape[1]), dtype=np.float32), []
    return vt.vectors[idxs], idxs


def compute_suite_distances(
    vtraces: list[VectorizedTrace],
    gt_vectors_by_case: dict[str, np.ndarray],
    tau: float = DEFAULT_TAU,
    residual_mode: str = "all",
) -> SuiteDistances:
    n = len(vtraces)
    case_ids = [vt.trace.case_id for vt in vtraces]

    matched_to_gt: dict[str, list[bool]] = {}
    gt_index_of_event: dict[str, list[int | None]] = {}
    residual_seqs: list[np.ndarray] = []
    residual_lengths: list[int] = []

    for vt in vtraces:
        gt_vec = gt_vectors_by_case[vt.trace.case_id]
        align = align_to_ground_truth(vt.vectors, gt_vec, tau=tau)
        matched_to_gt[vt.trace.case_id] = align.matched_to_gt
        gt_index_of_event[vt.trace.case_id] = align.gt_index_of_event
        res_vec, _ = _residual_vectors(vt, align.matched_to_gt, residual_mode)
        residual_seqs.append(res_vec)
        residual_lengths.append(len(res_vec))

    raw_matrix = np.zeros((n, n), dtype=np.float32)
    residual_matrix = np.zeros((n, n), dtype=np.float32)

    for i in range(n):
        for j in range(i + 1, n):
            d_raw = dtw_distance(vtraces[i].vectors, vtraces[j].vectors).distance
            d_res = dtw_distance(residual_seqs[i], residual_seqs[j]).distance
            raw_matrix[i, j] = raw_matrix[j, i] = max(d_raw, 0.0)
            residual_matrix[i, j] = residual_matrix[j, i] = max(d_res, 0.0)

    return SuiteDistances(
        case_ids=case_ids,
        raw_matrix=raw_matrix,
        residual_matrix=residual_matrix,
        residual_lengths=residual_lengths,
        matched_to_gt=matched_to_gt,
        gt_index_of_event=gt_index_of_event,
    )
