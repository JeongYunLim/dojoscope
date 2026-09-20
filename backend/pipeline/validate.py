"""
PDF 5장 "결과가 쓸모 있는지 어떻게 아나"를 구현하고, 여기에 순열 검정
(permutation test)을 더해 "이 실루엣 값이 우연히 나올 수 있는 수준인가"를
정량적으로 답한다.

배경: 표본 크기가 작을 때(예: suite당 48케이스) 실루엣 계수 0.1~0.2 정도의
차이는 우연히도 나올 수 있다. 리뷰어가 반드시 묻는 질문 "그 개선이 노이즈가
아니라는 근거가 있는가"에 답하기 위해, 라벨을 무작위로 섞었을 때 나오는
실루엣 계수의 영귀무분포(null distribution)를 만들고, 관측값이 그 분포에서
상위 몇 %에 해당하는지(p-value)를 계산한다.

성능 노트: sklearn의 silhouette_score는 호출마다 입력 검증 등 오버헤드가 있어,
"라벨만 다르고 거리행렬은 고정"인 순열 반복(수백~수천 회)에서는 그 오버헤드가
누적되어 눈에 띄게 느려진다(suite당 실측 약 2초, 4 suite면 8초). 그래서
- 공식 관측값(observed score)은 정확성이 검증된 sklearn을 그대로 쓰고,
- 순열 루프 내부에서는 numpy로 직접 벡터화한 _fast_silhouette를 쓴다
  (같은 정의를 구현했으며, tests/test_validate.py에서 sklearn과 수치가
  일치하는지 확인한다).
"""

from __future__ import annotations

import random

import numpy as np
from sklearn.metrics import silhouette_score

LABEL_FIELDS = ["user_task_id", "hijack_tool", "delay_bucket", "exposure_channel", "verdict"]
N_PERMUTATIONS = 200  # 500 -> 200: p-value 해상도(1/201≈0.5%)는 유지하면서 체감 속도를 개선
PERM_SEED = 42


def compute_silhouette_by_label(distance_matrix: np.ndarray, labels: list) -> float | None:
    n = len(labels)
    if n < 3:
        return None
    non_null = [i for i, l in enumerate(labels) if l is not None]
    if len(non_null) < 3:
        return None
    sub_labels = [labels[i] for i in non_null]
    if len(set(sub_labels)) < 2:
        return None
    sub_matrix = distance_matrix[np.ix_(non_null, non_null)]
    try:
        return float(silhouette_score(sub_matrix, sub_labels, metric="precomputed"))
    except ValueError:
        return None


def _fast_silhouette(distance_matrix: np.ndarray, encoded_labels: np.ndarray, n_clusters: int) -> float:
    """sklearn.metrics.silhouette_score(metric="precomputed")와 동일한 정의를
    one-hot 행렬곱으로 벡터화한 구현. 군집 크기가 1인 표본의 실루엣은
    관례대로 0으로 둔다(sklearn과 동일)."""
    n = len(encoded_labels)
    one_hot = np.zeros((n, n_clusters), dtype=np.float64)
    one_hot[np.arange(n), encoded_labels] = 1.0
    counts = one_hot.sum(axis=0)

    sum_to_cluster = distance_matrix @ one_hot  # (n, k): i에서 군집 c까지 거리 합
    own_counts = counts[encoded_labels]
    own_sum = sum_to_cluster[np.arange(n), encoded_labels]
    a = np.where(own_counts > 1, own_sum / np.maximum(own_counts - 1, 1), 0.0)

    mean_to_cluster = sum_to_cluster / np.maximum(counts[None, :], 1e-12)
    mask = np.ones((n, n_clusters), dtype=bool)
    mask[np.arange(n), encoded_labels] = False
    b = np.where(mask, mean_to_cluster, np.inf).min(axis=1)

    denom = np.maximum(a, b)
    s = np.where(denom > 0, (b - a) / denom, 0.0)
    s = np.where(own_counts <= 1, 0.0, s)
    return float(s.mean())


def permutation_pvalue(
    distance_matrix: np.ndarray,
    labels: list,
    observed: float | None,
    n_permutations: int = N_PERMUTATIONS,
    seed: int = PERM_SEED,
) -> float | None:
    """
    관측된 실루엣 계수가 라벨을 무작위로 섞은 영귀무분포에서 얼마나 극단적인
    값인지를 편측(단측, "관측값이 우연보다 크다") p-value로 반환한다.
    p = (무작위로 섞었을 때 관측값 이상이 나온 횟수 + 1) / (n_permutations + 1)
    (+1 보정은 표준적인 몬테카를로 p-value 편향 보정, North et al., 2002)
    """
    if observed is None:
        return None
    non_null_idx = [i for i, l in enumerate(labels) if l is not None]
    if len(non_null_idx) < 3:
        return None
    sub_labels = [labels[i] for i in non_null_idx]
    unique_labels = sorted(set(sub_labels), key=str)
    if len(unique_labels) < 2:
        return None
    sub_matrix = distance_matrix[np.ix_(non_null_idx, non_null_idx)]

    label_to_int = {lab: i for i, lab in enumerate(unique_labels)}
    encoded = np.array([label_to_int[lab] for lab in sub_labels])
    n_clusters = len(unique_labels)

    rng = np.random.default_rng(seed)
    count_ge = 0
    shuffled = encoded.copy()
    for _ in range(n_permutations):
        rng.shuffle(shuffled)
        score = _fast_silhouette(sub_matrix, shuffled, n_clusters)
        if score >= observed:
            count_ge += 1
    return (count_ge + 1) / (n_permutations + 1)


def validate_suite(traces: list, raw_matrix: np.ndarray, residual_matrix: np.ndarray) -> dict:
    """traces: pipeline.schema.Trace 리스트 (case_ids 순서와 동일해야 함).

    반환 구조: {"raw": {field: score}, "residual": {field: score},
                "raw_pvalue": {field: p}, "residual_pvalue": {field: p}}
    p < 0.05면 "라벨과 무관한 우연한 군집화일 가능성이 5% 미만"이라는 뜻이다.
    """
    result = {"raw": {}, "residual": {}, "raw_pvalue": {}, "residual_pvalue": {}}
    for field in LABEL_FIELDS:
        labels = [getattr(t, field) for t in traces]

        raw_score = compute_silhouette_by_label(raw_matrix, labels)
        res_score = compute_silhouette_by_label(residual_matrix, labels)
        result["raw"][field] = raw_score
        result["residual"][field] = res_score

        result["raw_pvalue"][field] = permutation_pvalue(raw_matrix, labels, raw_score)
        result["residual_pvalue"][field] = permutation_pvalue(residual_matrix, labels, res_score)
    return result
