"""Distance-space diagnostics that stay independent of the 2D UMAP projection.

UMAP is useful for visual exploration, but it can distort density and global distance.
For triage we therefore derive a simple isolation score directly from the original
pairwise DTW distance matrix: the mean distance to the k nearest neighbours.

The percentile is descriptive, not a hypothesis test.  It is intended to answer
"which traces are unusually unlike the rest in the original behavior-distance
space?" without treating a visually isolated UMAP point as statistical evidence.
"""

from __future__ import annotations

import numpy as np


def knn_isolation(distance_matrix: np.ndarray, k: int = 5) -> tuple[np.ndarray, np.ndarray, int]:
    """Return ``(mean_knn_distance, percentile, resolved_k)`` for each row.

    ``distance_matrix`` must be square, symmetric enough for a distance matrix, and
    have a zero diagonal.  The implementation is deliberately dependency-free.
    Percentile is in [0, 1]; 1 means the most isolated score (ties share a value).
    """
    dm = np.asarray(distance_matrix, dtype=float)
    if dm.ndim != 2 or dm.shape[0] != dm.shape[1]:
        raise ValueError("distance_matrix must be square")
    n = dm.shape[0]
    if n == 0:
        return np.array([], dtype=float), np.array([], dtype=float), 0
    if not np.isfinite(dm).all():
        raise ValueError("distance_matrix contains non-finite values")
    if n == 1:
        return np.array([0.0]), np.array([0.0]), 0

    resolved_k = max(1, min(int(k), n - 1))
    scores = np.empty(n, dtype=float)
    for i in range(n):
        row = np.delete(dm[i], i)
        nearest = np.partition(row, resolved_k - 1)[:resolved_k]
        scores[i] = float(nearest.mean())

    # Empirical percentile with ties receiving the same "<= score" percentile.
    # Subtract one self observation so the minimum can be 0 and maximum 1.
    percentiles = np.array([
        (np.count_nonzero(scores <= s) - 1) / (n - 1) for s in scores
    ], dtype=float)
    return scores, percentiles, resolved_k
