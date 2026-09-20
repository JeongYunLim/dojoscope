"""
거리 행렬 → 2D 좌표 (PDF 4단계).
metric="precomputed"로 UMAP에 거리 행렬을 직접 넣는다.
케이스 수가 적을 때(n_neighbors보다 작을 때) UMAP이 에러를 내므로
n_neighbors를 데이터 크기에 맞춰 자동으로 줄인다.
"""

from __future__ import annotations

import warnings

import numpy as np


def project_2d(distance_matrix: np.ndarray, seed: int = 42) -> np.ndarray:
    n = distance_matrix.shape[0]
    if n == 0:
        return np.zeros((0, 2))
    if n == 1:
        return np.zeros((1, 2))
    if n <= 3:
        # UMAP은 아주 작은 표본에서 불안정하므로 MDS류의 간단한 대안(고전 MDS)으로 대체.
        return _classical_mds(distance_matrix)

    import umap  # 지연 임포트: 대용량 의존성이라 필요할 때만 로드

    n_neighbors = max(2, min(15, n - 1))
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        metric="precomputed",
        random_state=seed,
        min_dist=0.1,
        # random_state만 고정하고 n_jobs를 기본값(-1, 병렬)으로 두면 numba의 병렬
        # SGD 최적화 단계가 프로세스마다 다른 스레드 스케줄로 실행되어, 같은 거리
        # 행렬·같은 seed로도 "화면에 그려진 지도"가 실행할 때마다 달라지는 문제가
        # 실제로 있었다 — 발표 슬라이드의 UMAP 이미지와 이 서버가 매번 새로 계산한
        # UMAP이 달라 보인 원인이 이것으로 확인됐다(같은 거리행렬을 n_jobs=1로 다시
        # 투영하면 슬라이드가 참조한 좌표와 소수점까지 일치했다). n_jobs=1로 고정해
        # 완전한 재현성을 보장한다.
        n_jobs=1,
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=UserWarning)
        coords = reducer.fit_transform(distance_matrix.astype(np.float64))
    return coords


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
