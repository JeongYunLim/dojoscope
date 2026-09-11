import numpy as np
import pytest

from pipeline.diagnostics import knn_isolation


def test_knn_isolation_marks_distant_point_highest():
    dm = np.array([
        [0.0, 1.0, 1.2, 8.0],
        [1.0, 0.0, 1.1, 8.2],
        [1.2, 1.1, 0.0, 7.9],
        [8.0, 8.2, 7.9, 0.0],
    ])
    scores, pct, k = knn_isolation(dm, k=2)
    assert k == 2
    assert int(np.argmax(scores)) == 3
    assert pct[3] == pytest.approx(1.0)


def test_knn_isolation_clamps_k_and_handles_singleton():
    dm = np.array([[0.0, 2.0], [2.0, 0.0]])
    scores, pct, k = knn_isolation(dm, k=99)
    assert k == 1
    assert scores.tolist() == [2.0, 2.0]
    assert pct.tolist() == [1.0, 1.0]

    scores1, pct1, k1 = knn_isolation(np.array([[0.0]]), k=5)
    assert k1 == 0
    assert scores1.tolist() == [0.0]
    assert pct1.tolist() == [0.0]


def test_knn_isolation_rejects_bad_matrix():
    with pytest.raises(ValueError):
        knn_isolation(np.zeros((2, 3)))
