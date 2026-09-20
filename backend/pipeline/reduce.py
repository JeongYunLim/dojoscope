"""
거리 행렬 → 2D 좌표 (PDF 4단계).
metric="precomputed"로 UMAP에 거리 행렬을 직접 넣는다.
케이스 수가 적을 때(n_neighbors보다 작을 때) UMAP이 에러를 내므로
n_neighbors를 데이터 크기에 맞춰 자동으로 줄인다.
"""

from __future__ import annotations

import warnings

import numpy as np

# n_neighbors 후보 — 고정값 15 하나만 썼더니 "군집이 화면에서 제대로 안 뭉쳐
# 보인다"는 문제가 실제로 있었다. 원인은 UMAP이 아주 작은 n_neighbors로는
# 국소 이웃만 보고 전역 거리 구조(군집끼리 서로 얼마나 떨어져 있는지)를 잘
# 못 지킨다는 것 — suite마다 4개 후보로 UMAP을 각각 돌려서 원래 거리행렬과
# 2D 좌표간 거리의 스피어만 상관계수(순위가 얼마나 유지되는지)가 가장 높은
# 것을 자동으로 고른다(select_k_by_silhouette와 같은 원칙: 추측하지 않고
# 데이터로 직접 스윕해서 고른다). 실측 결과 최적값이 suite마다 15~40으로
# 갈렸다(banking/slack은 40, travel/workspace는 15가 최고) — 고정값 하나로는
# 어느 쪽이든 손해를 본다.
N_NEIGHBORS_CANDIDATES = (10, 15, 25, 40)


def project_2d(distance_matrix: np.ndarray, seed: int = 42) -> tuple[np.ndarray, int]:
    """반환값: (2D 좌표, 실제로 선택된 n_neighbors)."""
    n = distance_matrix.shape[0]
    if n == 0:
        return np.zeros((0, 2)), 0
    if n == 1:
        return np.zeros((1, 2)), 0
    if n <= 3:
        # UMAP은 아주 작은 표본에서 불안정하므로 MDS류의 간단한 대안(고전 MDS)으로 대체.
        return _classical_mds(distance_matrix), 0

    import umap  # 지연 임포트: 대용량 의존성이라 필요할 때만 로드
    from scipy.stats import spearmanr

    candidates = sorted({nn for nn in N_NEIGHBORS_CANDIDATES if 2 <= nn < n})
    if not candidates:
        candidates = [max(2, min(15, n - 1))]

    D = distance_matrix.astype(np.float64)
    iu = np.triu_indices(n, k=1)
    orig_flat = D[iu]

    # 후보 하나당 딱 한 번(seed 고정)만 돌려서 스피어만 상관계수로 비교했더니,
    # 실제로 이 스코어가 UMAP의 확률적 SGD 최적화 노이즈에 크게 흔들린다는 게
    # 실측으로 드러났다 — 같은 n_neighbors라도 seed만 바꾸면 점수가 후보들
    # 사이의 점수 차이(수 %포인트)보다 더 크게(표준편차 2~8%포인트) 흔들려서,
    # "제일 점수 높은 후보를 고른다"는 게 실은 진짜 신호가 아니라 그 한 번의
    # 실행이 우연히 잘 나왔는지를 고르는 것과 다르지 않았다(travel suite에서
    # 이 노이즈 때문에 평균적으로는 더 나쁜 n_neighbors=10이 뽑혀, banking(=40)
    # 보다 지도 위 점들이 훨씬 더 흩어져 보이는 원인이 됐다 — suite마다 실제
    # 거리행렬 통계는 큰 차이가 없었는데도 그랬다). 후보마다 서로 다른 고정
    # seed 여러 개(REPEATS_PER_CANDIDATE개, seed, seed+1, seed+2)로 반복해
    # 평균 점수로 비교하면 이 노이즈가 줄어든다 — seed 목록 자체는 고정값이라
    # 재현성(n_jobs=1과 같은 목적)은 그대로 유지된다.
    REPEATS_PER_CANDIDATE = 3

    def _fit_and_score(n_neighbors: int, run_seed: int):
        reducer = umap.UMAP(
            n_components=2,
            n_neighbors=n_neighbors,
            metric="precomputed",
            random_state=run_seed,
            min_dist=0.1,
            # random_state만 고정하고 n_jobs를 기본값(-1, 병렬)으로 두면 numba의
            # 병렬 SGD 최적화 단계가 프로세스마다 다른 스레드 스케줄로 실행되어,
            # 같은 거리행렬·같은 seed로도 "화면에 그려진 지도"가 실행할 때마다
            # 달라지는 문제가 실제로 있었다 — 발표 슬라이드의 UMAP 이미지와 이
            # 서버가 매번 새로 계산한 UMAP이 달라 보인 원인이 이것으로 확인됐다
            # (같은 거리행렬을 n_jobs=1로 다시 투영하면 슬라이드가 참조한
            # 좌표와 소수점까지 일치했다). n_jobs=1로 고정해 완전한 재현성을
            # 보장한다.
            n_jobs=1,
        )
        coords = reducer.fit_transform(D)
        proj_flat = np.sqrt(((coords[iu[0]] - coords[iu[1]]) ** 2).sum(axis=1))
        score, _ = spearmanr(orig_flat, proj_flat)
        return coords, (score if score is not None and not np.isnan(score) else -2.0)

    best_coords, best_nn, best_mean_score = None, candidates[0], -2.0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=UserWarning)
        for n_neighbors in candidates:
            scores = []
            base_coords = None
            for rep in range(REPEATS_PER_CANDIDATE):
                coords, score = _fit_and_score(n_neighbors, seed + rep)
                scores.append(score)
                if rep == 0:
                    base_coords = coords  # 화면에 실제로 쓸 좌표는 기존과 같이 base seed 결과로 고정
            mean_score = float(np.mean(scores))
            if mean_score > best_mean_score:
                best_mean_score, best_coords, best_nn = mean_score, base_coords, n_neighbors
    return best_coords, best_nn


def _classical_mds(distance_matrix: np.ndarray) -> np.ndarray:
    n = distance_matrix.shape[0]
    d2 = distance_matrix ** 2
    j = np.eye(n) - np.ones((n, n)) / n
    b = -0.5 * j @ d2 @ j
    eigvals, eigvecs = np.linalg.eigh(b)
    order = np.argsort(eigvals)[::-1]
    eigvals, eigvecs = eigvals[order], eigvecs[:, order]
    top2 = np.maximum(eigvals[:2], 0)
    coords = eigvecs[:, :2] * np.sqrt(top2)
    return coords
