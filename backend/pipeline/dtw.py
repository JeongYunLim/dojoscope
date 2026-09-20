"""
DTW(Dynamic Time Warping) 핵심 구현.
PDF 2단계 "시퀀스끼리 거리 재기"를 그대로 옮긴다.

- 로컬 비용(cell cost)은 두 이벤트 벡터의 코사인 거리.
- 누적 비용 최소 경로를 격자 DP로 찾고, 최종 거리는 "경로 길이로 정규화"한다
  (PDF 7장: "이벤트 벡터 간 코사인 거리 위의 DTW, 경로 길이로 정규화").
- 정렬 경로(alignment path)도 함께 반환해서, 3단계(GT 정렬/잔차 추출)와
  프론트엔드의 3자 정렬 뷰에 그대로 재사용한다.

빈 시퀀스 처리:
  한쪽이 빈 시퀀스(예: 잔차가 아예 없는 케이스)면 DTW를 정의할 수 없으므로,
  거리는 "다른 쪽 시퀀스 벡터들의 원점(zero vector)까지의 평균 코사인 거리"로
  정의한다. 둘 다 비면 거리는 0.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def _cosine_distance_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a_norm = a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-12)
    b_norm = b / (np.linalg.norm(b, axis=1, keepdims=True) + 1e-12)
    sim = np.clip(a_norm @ b_norm.T, -1.0, 1.0)
    dist = 1.0 - sim  # (n, m), 0=완전히 같음, 2=완전히 반대
    return np.clip(dist, 0.0, None)  # 부동소수 오차로 생기는 미세한 음수 제거


@dataclass
class DTWResult:
    distance: float                    # 경로 길이로 정규화된 거리
    path: list[tuple[int, int]]        # [(a_index, b_index), ...] 정렬 경로 (짝지어진 쌍)
    cost_matrix: np.ndarray            # 격자 위 각 셀의 로컬 코사인 거리 (디버깅/시각화용)


def dtw_distance(a: np.ndarray, b: np.ndarray) -> DTWResult:
    n, m = len(a), len(b)

    if n == 0 and m == 0:
        return DTWResult(distance=0.0, path=[], cost_matrix=np.zeros((0, 0)))
    if n == 0:
        d = float(np.linalg.norm(b, axis=1).mean())  # 원점까지 평균 거리로 근사
        return DTWResult(distance=d, path=[], cost_matrix=np.zeros((0, m)))
    if m == 0:
        d = float(np.linalg.norm(a, axis=1).mean())
        return DTWResult(distance=d, path=[], cost_matrix=np.zeros((n, 0)))

    cost = _cosine_distance_matrix(a, b)

    # 누적 비용 격자. acc[i, j] = a[:i+1], b[:j+1]까지의 최소 누적 비용.
    acc = np.full((n, m), np.inf, dtype=np.float64)
    acc[0, 0] = cost[0, 0]
    for i in range(1, n):
        acc[i, 0] = acc[i - 1, 0] + cost[i, 0]
    for j in range(1, m):
        acc[0, j] = acc[0, j - 1] + cost[0, j]
    for i in range(1, n):
        row_cost = cost[i]
        for j in range(1, m):
            acc[i, j] = row_cost[j] + min(acc[i - 1, j], acc[i, j - 1], acc[i - 1, j - 1])

    # 경로 역추적
    path: list[tuple[int, int]] = []
    i, j = n - 1, m - 1
    path.append((i, j))
    while i > 0 or j > 0:
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            choices = [
                (acc[i - 1, j - 1], i - 1, j - 1),
                (acc[i - 1, j], i - 1, j),
                (acc[i, j - 1], i, j - 1),
            ]
            _, i, j = min(choices, key=lambda c: c[0])
        path.append((i, j))
    path.reverse()

    # 경로 길이로 정규화 (경로 각 스텝의 로컬 비용 평균)
    total = sum(cost[pi, pj] for pi, pj in path)
    normalized = total / len(path)

    return DTWResult(distance=float(normalized), path=path, cost_matrix=cost)
