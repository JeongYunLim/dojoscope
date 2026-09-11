"""
계층적 군집화(Agglomerative Clustering, average linkage).

이 파이프라인은 원래 거리행렬(distances.py)까지만 계산하고, "라벨 없이 거리만
보고 그룹을 나누는" 단계가 없었다. UMAP(reduce.py)은 차원 축소일 뿐 군집을
나눠주지 않고, 실루엣 검증(validate.py)은 이미 아는 라벨을 검증하는 도구라
새 군집을 만들어주지 않는다 — 그 사이 빠져 있던 단계를 여기서 채운다.

거리행렬만 있고 원래 좌표(coordinate)가 없으므로, "군집 중심 = 벡터 평균"이
필요한 KMeans 계열은 쓸 수 없다. 계층적 군집화는 두 군집 사이의 거리만
정의하면 되므로(linkage), precomputed distance matrix 위에서 그대로 동작한다.

scipy에도 동일한 기능(scipy.cluster.hierarchy.linkage)이 있지만, 이 프로젝트의
목적상(README의 "직접 짜보며 이해한다") numpy만으로 처음부터 구현한다. 출력
형식(Z: [군집id1, 군집id2, 병합거리, 원소개수])은 scipy linkage와 동일하게
맞춰서, 필요하면 scipy의 덴드로그램 등 도구와도 바로 호환된다.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class ClusterResult:
    labels: list[int]         # case_ids와 같은 순서, 0..k-1
    merge_log: np.ndarray      # (n-1, 4) — [군집id1, 군집id2, 병합거리, 원소개수]
    k: int


def agglomerative_clustering(D: np.ndarray, linkage: str = "average") -> np.ndarray:
    """거리행렬 D(n x n)만 보고 병합 순서를 계산해 Z 행렬을 반환한다.

    linkage:
      average  - 두 군집에 속한 모든 (원소,원소) 쌍 거리의 평균 (기본값, 안정적)
      complete - 그 중 가장 먼 거리 (더 촘촘하고 작은 군집을 만드는 경향)
      single   - 그 중 가장 가까운 거리 (체인처럼 길게 늘어지기 쉬움 - 비권장)
    """
    n = D.shape[0]
    if n == 0:
        return np.zeros((0, 4))
    active = list(range(n))
    members = {i: [i] for i in range(n)}
    Z = []
    next_id = n

    while len(active) > 1:
        best = None  # (distance, cluster_a, cluster_b)
        for ia in range(len(active)):
            for ib in range(ia + 1, len(active)):
                a, b = active[ia], active[ib]
                pair_dists = [D[p, q] for p in members[a] for q in members[b]]
                if linkage == "average":
                    d = float(np.mean(pair_dists))
                elif linkage == "complete":
                    d = float(np.max(pair_dists))
                elif linkage == "single":
                    d = float(np.min(pair_dists))
                else:
                    raise ValueError(f"알 수 없는 linkage: {linkage}")
                if best is None or d < best[0]:
                    best = (d, a, b)

        d, a, b = best
        new_members = members[a] + members[b]
        Z.append([a, b, d, len(new_members)])
        members[next_id] = new_members
        del members[a]
        del members[b]
        active = [c for c in active if c not in (a, b)] + [next_id]
        next_id += 1

    return np.array(Z, dtype=float)


def cut_into_k_clusters(Z: np.ndarray, n: int, k: int) -> list[int]:
    """병합 기록 Z를 처음 (n-k)번만 재생해서 k개 군집이 남았을 때의
    '점 -> 군집 라벨(0..k-1)' 리스트를 만든다."""
    if n == 0:
        return []
    k = max(1, min(k, n))
    members = {i: [i] for i in range(n)}
    next_id = n
    n_merges = n - k
    for step in range(n_merges):
        a, b, _, _ = Z[step]
        a, b = int(a), int(b)
        new_members = members.pop(a) + members.pop(b)
        members[next_id] = new_members
        next_id += 1

    labels = [0] * n
    for cluster_label, (_, pts) in enumerate(members.items()):
        for p in pts:
            labels[p] = cluster_label
    return labels


def cluster_distance_matrix(D: np.ndarray, k: int, linkage: str = "average") -> ClusterResult:
    n = D.shape[0]
    Z = agglomerative_clustering(D, linkage=linkage)
    labels = cut_into_k_clusters(Z, n, k) if n > 0 else []
    return ClusterResult(labels=labels, merge_log=Z, k=k)


def cluster_agreement(labels: list[int], reference: list) -> dict[str, float] | None:
    """군집 라벨이 다른 라벨(예: hijack_tool)과 얼마나 일치하는지.
    ARI/NMI는 우연을 보정하는 표준 지표라(scikit-learn 구현 재사용),
    군집 크기가 불균등해도 순도(purity)처럼 왜곡되지 않는다."""
    non_null = [i for i, v in enumerate(reference) if v is not None]
    if len(non_null) < 3:
        return None
    ref_sub = [reference[i] for i in non_null]
    lab_sub = [labels[i] for i in non_null]
    if len(set(ref_sub)) < 2 or len(set(lab_sub)) < 2:
        return None
    from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

    return {
        "ari": float(adjusted_rand_score(ref_sub, lab_sub)),
        "nmi": float(normalized_mutual_info_score(ref_sub, lab_sub)),
    }
