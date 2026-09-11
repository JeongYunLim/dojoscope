"""pipeline/validate.py의 _fast_silhouette가 sklearn.metrics.silhouette_score와
정확히 같은 값을 내는지 검증한다 (순열 검정 속도를 위해 자체 구현으로
바꿨으므로, 정의가 어긋나면 p-value 전체가 틀어진다)."""

import numpy as np
import pytest
from sklearn.metrics import silhouette_score

from pipeline.validate import _fast_silhouette, permutation_pvalue


def _random_case(n, n_clusters, seed):
    rng = np.random.default_rng(seed)
    a = rng.normal(size=(n, 4))
    d = np.linalg.norm(a[:, None, :] - a[None, :, :], axis=-1)
    labels = rng.integers(0, n_clusters, size=n)
    return d, labels


@pytest.mark.parametrize("seed", [0, 1, 2, 3, 4])
def test_fast_silhouette_matches_sklearn(seed):
    d, labels = _random_case(30, 4, seed)
    if len(set(labels.tolist())) < 2:
        pytest.skip("이 시드에서는 군집이 1개뿐이라 실루엣이 정의되지 않음")
    expected = silhouette_score(d, labels, metric="precomputed")
    actual = _fast_silhouette(d, labels, n_clusters=int(labels.max()) + 1)
    assert actual == pytest.approx(expected, abs=1e-9)


def test_fast_silhouette_handles_singleton_cluster():
    # 마지막 표본만 혼자인 군집 -> sklearn 관례상 그 표본의 실루엣은 0
    d, labels = _random_case(10, 2, seed=7)
    labels[-1] = 2  # 군집 2에는 이 표본 하나뿐
    expected = silhouette_score(d, labels, metric="precomputed")
    actual = _fast_silhouette(d, labels, n_clusters=3)
    assert actual == pytest.approx(expected, abs=1e-9)


def test_permutation_pvalue_runs_fast_and_returns_valid_range():
    d, labels_arr = _random_case(48, 3, seed=1)
    labels = labels_arr.tolist()
    observed = silhouette_score(d, labels, metric="precomputed")
    p = permutation_pvalue(d, labels, observed, n_permutations=50, seed=1)
    assert p is not None
    assert 0.0 < p <= 1.0
