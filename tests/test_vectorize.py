"""pipeline/vectorize.py의 Embedder(LSA 폴백 경로) 테스트.

이 샌드박스/CI 환경에는 sentence-transformers가 설치되어 있지 않으므로
Embedder는 항상 LSA 경로로 폴백한다 — 이는 결함이 아니라 설계된 동작이며,
이 테스트는 바로 그 폴백 경로가 올바르게 동작하는지를 검증한다.
"""

import numpy as np

from pipeline.vectorize import EMBED_DIM, Embedder, collect_corpus, vectorize_ground_truth, vectorize_trace
from pipeline.schema import Event, Trace


def _toy_trace():
    events = [
        Event(index=0, role="user", text="hello"),
        Event(index=1, role="tool_call", function="read_file", args={"path": "a.txt"}),
        Event(index=2, role="tool_resp", function="read_file", text="content"),
    ]
    return Trace(
        suite="banking", user_task_id="u0", injection_task_id="i0", condition="A", model="m",
        events=events, ground_truth=["read_file"], utility=True, security=False,
    )


def test_embedder_falls_back_to_lsa_without_sentence_transformers():
    emb = Embedder()
    assert emb.backend == "lsa"


def test_encode_shape_matches_embed_dim_after_fit():
    trace = _toy_trace()
    emb = Embedder()
    emb.fit(collect_corpus([trace]))
    vecs = emb.encode(["assistant calls read_file with path=a.txt"])
    assert vecs.shape == (1, EMBED_DIM)


def test_encode_raises_before_fit_on_lsa_backend():
    emb = Embedder()
    try:
        emb.encode(["assistant calls read_file"])
        assert False, "fit() 이전에 encode()가 예외 없이 성공하면 안 된다"
    except RuntimeError:
        pass


def test_vectorize_trace_produces_390_dim_vectors():
    trace = _toy_trace()
    emb = Embedder()
    emb.fit(collect_corpus([trace]))
    vt = vectorize_trace(trace, emb, flag_weight=0.5)
    assert vt.vectors.shape == (len(trace.events), EMBED_DIM + 6)


def test_vectorize_ground_truth_has_zero_structural_flags():
    trace = _toy_trace()
    emb = Embedder()
    emb.fit(collect_corpus([trace]))
    gt_vec = vectorize_ground_truth(trace.ground_truth, emb)
    assert gt_vec.shape == (1, EMBED_DIM + 6)
    # 마지막 6개 차원(구조 플래그)은 항상 0이어야 한다
    assert np.allclose(gt_vec[:, EMBED_DIM:], 0.0)
