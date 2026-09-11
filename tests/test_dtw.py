"""pipeline/dtw.py에 대한 정합성 테스트.

DTW 구현이 지켜야 할 최소한의 수학적 성질들을 검증한다:
1. 동일한 시퀀스끼리는 거리 0이어야 한다.
2. 코사인 거리 자체가 항상 0 이상이어야 한다(부동소수 오차로 음수가 새지 않는지).
3. 한쪽이 빈 시퀀스인 경우에도 예외 없이 정의된 값을 반환해야 한다(원점까지의 평균 거리).
4. 정렬 경로(path)는 항상 (0,0)에서 시작해서 (n-1, m-1)에서 끝나야 한다.
"""

import numpy as np
import pytest

from pipeline.dtw import dtw_distance


def _seq(vectors):
    return np.array(vectors, dtype=np.float32)


def test_identical_sequences_have_zero_distance():
    seq = _seq([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    result = dtw_distance(seq, seq)
    assert result.distance == pytest.approx(0.0, abs=1e-6)


def test_distance_is_never_negative():
    rng = np.random.default_rng(0)
    a = rng.normal(size=(6, 8)).astype(np.float32)
    b = rng.normal(size=(9, 8)).astype(np.float32)
    result = dtw_distance(a, b)
    assert result.distance >= 0.0
    assert np.all(result.cost_matrix >= -1e-6)


def test_empty_sequence_uses_origin_distance_fallback():
    a = _seq([[1, 0], [0, 1]])
    empty = np.zeros((0, 2), dtype=np.float32)

    result_a_empty = dtw_distance(empty, a)
    assert result_a_empty.path == []
    assert result_a_empty.distance == pytest.approx(float(np.linalg.norm(a, axis=1).mean()))

    result_both_empty = dtw_distance(empty, empty)
    assert result_both_empty.distance == 0.0


def test_alignment_path_spans_full_sequences():
    a = _seq([[1, 0], [0, 1], [1, 1]])
    b = _seq([[1, 0], [1, 1]])
    result = dtw_distance(a, b)
    assert result.path[0] == (0, 0)
    assert result.path[-1] == (len(a) - 1, len(b) - 1)
    # 경로는 단조 증가해야 한다 (역행 불가)
    for (i0, j0), (i1, j1) in zip(result.path, result.path[1:]):
        assert i1 >= i0 and j1 >= j0


def test_more_similar_sequence_yields_smaller_distance():
    """직관적 sanity check: b가 a와 방향이 더 비슷할수록 거리가 작아야 한다."""
    a = _seq([[1, 0, 0], [1, 0, 0]])
    close = _seq([[0.9, 0.1, 0], [0.9, 0.1, 0]])
    far = _seq([[0, 1, 0], [0, 1, 0]])
    d_close = dtw_distance(a, close).distance
    d_far = dtw_distance(a, far).distance
    assert d_close < d_far
