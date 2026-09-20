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


def compute_medoids(D: np.ndarray, case_ids: list[str], labels: list[int], hijack_tools: list[str | None]) -> list[dict]:
    """군집별 대표 사례(medoid) — pipeline_study/umap_projection.py에서 가져온 개념.

    군집 중심을 벡터 평균(centroid)으로 잡으면 실제로 존재하지 않는 가상의 점이 되어
    "이 트레이스가 이 군집을 대표한다"고 손으로 가리킬 수 없다. medoid는 같은 군집
    안의 다른 모든 점과의 거리 합이 가장 작은 *실존하는* 케이스이므로, 방어 개발자가
    "이 군집이 대체로 어떤 행동인지" 볼 때 클릭해서 바로 열어볼 실제 트레이스를 준다."""
    if not labels:
        return []
    by_cluster: dict[int, list[int]] = {}
    for i, lab in enumerate(labels):
        by_cluster.setdefault(lab, []).append(i)

    medoids = []
    for cluster, idxs in sorted(by_cluster.items()):
        sub = D[np.ix_(idxs, idxs)]
        total_dist = sub.sum(axis=1)
        medoid_local = int(np.argmin(total_dist))
        medoid_idx = idxs[medoid_local]
        tools = [hijack_tools[i] for i in idxs if hijack_tools[i]]
        majority_tool = max(set(tools), key=tools.count) if tools else None
        medoids.append({
            "cluster": cluster,
            "case_id": case_ids[medoid_idx],
            "size": len(idxs),
            "majority_hijack_tool": majority_tool,
        })
    return medoids


def cluster_agreement(labels: list[int], reference: list) -> dict[str, float] | None:
    """군집 라벨이 다른 라벨(예: hijack_tool)과 얼마나 일치하는지.
    ARI/NMI는 우연을 보정하는 표준 지표라(scikit-learn 구현 재사용),
    군집 크기가 불균등해도 순도(purity)처럼 왜곡되지 않는다.

    weighted_purity(케이스 수 가중 다수결 일치율)도 함께 낸다 — pipeline_study의
    k-sweep 실험(study_pipeline.py)에서 도입한 지표. ARI/NMI는 "우연 대비 얼마나
    나은가"를 보정된 척도로 답하지만 방어 개발자에게는 "군집 N을 열어보면 실제로
    몇 %가 내가 기대한 라벨(예: 같은 hijack_tool)인가"라는 더 직접적인 숫자도
    필요하다. 크기 1인 군집이 무조건 순도 1.0을 받아 평균을 왜곡하는 이전 문제는
    "군집 개수로 평균"이 아니라 "케이스 수로 가중평균"해서 피한다."""
    non_null = [i for i, v in enumerate(reference) if v is not None]
    if len(non_null) < 3:
        return None
    ref_sub = [reference[i] for i in non_null]
    lab_sub = [labels[i] for i in non_null]
    if len(set(ref_sub)) < 2 or len(set(lab_sub)) < 2:
        return None
    from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score

    table: dict[int, dict] = {}
    for lab, ref in zip(lab_sub, ref_sub):
        table.setdefault(lab, {})[ref] = table.setdefault(lab, {}).get(ref, 0) + 1
    weighted_correct = sum(max(counts.values()) for counts in table.values())

    return {
        "ari": float(adjusted_rand_score(ref_sub, lab_sub)),
        "nmi": float(normalized_mutual_info_score(ref_sub, lab_sub)),
        "weighted_purity": weighted_correct / len(non_null),
    }


K_SWEEP = (2, 3, 4, 5, 6, 8, 10, 12, 16, 20)


def select_k_by_silhouette(D: np.ndarray, k_values=K_SWEEP, linkage: str = "average") -> tuple[int, list[dict]]:
    """군집 개수 k를 고정값(예전 기본값 6) 대신 데이터로부터 자동으로 고른다.

    pipeline_study/study_pipeline.py의 k-sweep 실험은 ARI(=hijack_tool과의 일치도)가
    가장 높은 k를 "최선"으로 골랐지만, 그건 검증에 쓸 라벨을 k를 고르는 데도 써버리는
    순환 논리다(같은 라벨을 두 번 쓰는 셈이라 "군집이 라벨을 잘 맞췄다"는 결론이
    부풀려진다). 대신 여기서는 라벨을 전혀 쓰지 않는 실루엣 계수(거리행렬 자체에서
    "자기 군집과는 가깝고 남의 군집과는 먼가"만 봄)가 가장 높은 k를 고른다 — 완전히
    비지도 기준이라 이후 라벨 검증(cluster_agreement)과 독립적이다.

    반환값: (선택된 k, k별 실루엣 스윕 표 — 화면에 그대로 노출해 어떤 k들을
    검토했는지 투명하게 보여줄 수 있다)."""
    from .validate import compute_silhouette_by_label

    n = D.shape[0]
    if n < 4:
        return min(2, max(1, n)), []

    Z = agglomerative_clustering(D, linkage=linkage)
    sweep = []
    best_k, best_score = None, -2.0
    for k in k_values:
        if k >= n:
            continue
        labels = cut_into_k_clusters(Z, n, k)
        sil = compute_silhouette_by_label(D, labels)
        sweep.append({"k": k, "silhouette": sil})
        if sil is not None and sil > best_score:
            best_score, best_k = sil, k
    if best_k is None:
        best_k = min(6, max(1, n - 1))
    return best_k, sweep
