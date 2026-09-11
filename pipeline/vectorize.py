"""
이벤트 하나를 390차원 벡터(384 의미 임베딩 + 6 구조 플래그)로 바꾼다.
PDF 1단계("이벤트 하나를 벡터로")를 그대로 구현한다.

임베딩 백엔드
-----------
두 개의 백엔드를 지원하며, 둘 다 동일한 `encode(texts) -> (n, 384)` 인터페이스를
따르므로 하위 파이프라인(DTW/UMAP/실루엣 검증)은 어떤 백엔드를 쓰든 코드 변경이
필요 없다. 이는 임베딩 방식 자체를 하나의 실험 축으로 다루기 위한 설계다
(예: "transformer 임베딩 vs. 고전적 LSA 임베딩이 잔차 지도 품질에 미치는 영향").

1. sentence-transformers (기본 시도) — bge-small-en-v1.5. 인터넷/모델 캐시가 필요하다.
2. LSA (자동 폴백) — TF-IDF(단어 1~2-gram) 위에 Truncated SVD를 얹은
   잠재 의미 분석(Latent Semantic Analysis, Deerwester et al., 1990). 외부
   모델·인터넷이 전혀 필요 없고, 코퍼스(현재 실행에 포함된 모든 이벤트 문장) 전체에
   대해 한 번만 학습(fit)한 뒤 각 이벤트를 transform한다. 완전히 결정론적이며
   scikit-learn(이미 핵심 의존성)만으로 동작한다.

   구버전의 해싱 트릭(md5 기반)은 재현 가능하지만 방법론적으로 근거를 대기 어려워
   LSA로 교체했다 — 두 경우 모두 오프라인에서 동작한다는 점은 같지만, LSA는
   말뭉치의 실제 단어 동시출현 통계를 반영하므로 "의미가 비슷한 호출은 가깝다"는
   요구를 정성적으로나마 만족한다.

구조 플래그 (6차원, PDF 그림 3과 동일)
    [0] is_tool_call
    [1] is_tool_resp
    [2] is_user
    [3] injected                         (0/1)
    [4] position_since_exposure_norm     (0~1, 노출 이후 몇 번째 이벤트인지를 정규화)
    [5] deviated                         (0/1, 정답 시퀀스에서 벗어난 지점 이후인가)

flag_weight로 임베딩(384) 대비 플래그(6)의 크기를 맞춘다.
PDF 8장 실험 결과, flag_weight=0.5가 2.0/1.0보다 모든 검증 지표에서 나았다.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np

from .schema import Event, Trace

EMBED_DIM = 384
FLAG_DIM = 6
VECTOR_DIM = EMBED_DIM + FLAG_DIM

_POSITION_NORM_WINDOW = 10  # "노출 이후 몇 번째" 를 0~1로 눌러 담는 창 크기


def serialize_event(ev: Event) -> str:
    """이벤트를 사람이 읽는 한 문장으로 직렬화한다 (PDF 그림 3의 '직렬화' 단계)."""
    if ev.role == "user":
        return f"user says: {ev.text or ''}".strip()
    if ev.role == "tool_call":
        args_str = ", ".join(f"{k}={v}" for k, v in (ev.args or {}).items())
        return f"assistant calls {ev.function} with {args_str}".strip()
    if ev.role == "tool_resp":
        base = f"tool {ev.function} responds: {ev.text or ''}"
        return base.strip()
    raise ValueError(f"알 수 없는 role: {ev.role}")


class Embedder:
    """
    sentence-transformers(bge-small-en-v1.5)를 우선 시도하고, 실패하면
    TF-IDF+SVD(LSA) 임베딩으로 자동 폴백하는 임베더.

    LSA 경로는 코퍼스 전체 통계가 필요하므로, vectorize_trace를 호출하기 전에
    반드시 fit(corpus_texts)을 먼저 호출해야 한다 (run_pipeline.py가 이 순서를
    지킨다). sentence-transformers 경로에서 fit은 아무 일도 하지 않는다
    (사전학습된 모델이라 코퍼스 학습이 필요 없기 때문).
    """

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5", seed: int = 42):
        self.model_name = model_name
        self.seed = seed
        self._model = None
        self._tfidf = None
        self._svd = None
        self._svd_components = EMBED_DIM
        self._backend = "lsa"  # 실제 모델 로드에 성공하면 "sentence-transformers"로 바뀜
        self._try_load_model()

    def _try_load_model(self):
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore

            self._model = SentenceTransformer(self.model_name)
            self._backend = "sentence-transformers"
        except Exception as e:  # noqa: BLE001 - 모델/네트워크 문제는 폴백으로 흡수
            warnings.warn(
                f"[Embedder] '{self.model_name}' 로드 실패 ({e!r}). "
                f"TF-IDF+SVD(LSA) 임베딩({EMBED_DIM}차원)으로 전환합니다. "
                f"실제 transformer 임베딩 품질이 필요하면 인터넷이 되는 환경에서 "
                f"`pip install -r requirements-embedding.txt` 후 모델 캐시를 준비하세요.",
                RuntimeWarning,
            )
            self._model = None
            self._backend = "lsa"

    @property
    def backend(self) -> str:
        return self._backend

    def fit(self, corpus_texts: list[str]) -> None:
        """LSA 경로에서만 의미가 있다. sentence-transformers 경로는 no-op."""
        if self._backend != "lsa":
            return
        from sklearn.decomposition import TruncatedSVD
        from sklearn.feature_extraction.text import TfidfVectorizer

        # 코퍼스가 아주 작을 수도 있으므로(단위 테스트, 소규모 suite) SVD 성분 수를
        # 실제 학습 가능한 최대치로 자동 축소하고, encode() 시점에 0으로 패딩해
        # 항상 EMBED_DIM 차원을 반환하도록 한다.
        self._tfidf = TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True)
        tfidf_matrix = self._tfidf.fit_transform(corpus_texts)
        max_components = max(1, min(EMBED_DIM, tfidf_matrix.shape[0] - 1, tfidf_matrix.shape[1] - 1))
        self._svd_components = max_components
        self._svd = TruncatedSVD(n_components=max_components, random_state=self.seed)
        self._svd.fit(tfidf_matrix)

    def encode(self, texts: list[str]) -> np.ndarray:
        if self._backend == "sentence-transformers":
            vecs = self._model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
            return np.asarray(vecs, dtype=np.float32)

        if self._tfidf is None or self._svd is None:
            raise RuntimeError(
                "LSA 임베더가 fit()되지 않았습니다. vectorize_trace 호출 전에 "
                "Embedder.fit(corpus_texts)을 먼저 실행하세요."
            )
        tfidf_matrix = self._tfidf.transform(texts)
        reduced = self._svd.transform(tfidf_matrix)  # (n, svd_components)
        if self._svd_components < EMBED_DIM:
            pad = np.zeros((reduced.shape[0], EMBED_DIM - self._svd_components), dtype=np.float32)
            reduced = np.concatenate([reduced, pad], axis=1)
        return reduced.astype(np.float32)


def structural_flags(ev: Event, trace: Trace) -> np.ndarray:
    is_tool_call = 1.0 if ev.role == "tool_call" else 0.0
    is_tool_resp = 1.0 if ev.role == "tool_resp" else 0.0
    is_user = 1.0 if ev.role == "user" else 0.0
    injected = 1.0 if ev.injected else 0.0

    if trace.injection_exposure is not None and ev.index >= trace.injection_exposure:
        raw_pos = ev.index - trace.injection_exposure
        position_since_exposure_norm = min(raw_pos / _POSITION_NORM_WINDOW, 1.0)
    else:
        position_since_exposure_norm = 0.0

    deviated = 0.0
    if trace.first_deviation is not None and ev.index >= trace.first_deviation:
        deviated = 1.0

    return np.array(
        [is_tool_call, is_tool_resp, is_user, injected, position_since_exposure_norm, deviated],
        dtype=np.float32,
    )


@dataclass
class VectorizedTrace:
    trace: Trace
    vectors: np.ndarray  # (n_events, VECTOR_DIM)


def collect_corpus(traces: list[Trace]) -> list[str]:
    """LSA 임베더 fit에 쓸 전체 코퍼스: 모든 trace의 모든 이벤트 직렬화 문장 +
    정답 시퀀스 문장. run_pipeline.py에서 파이프라인 시작 전에 한 번 호출한다."""
    texts: list[str] = []
    seen_gt: set[tuple] = set()
    for t in traces:
        texts.extend(serialize_event(ev) for ev in t.events)
        gt_key = tuple(t.ground_truth)
        if gt_key not in seen_gt:
            seen_gt.add(gt_key)
            texts.extend(f"assistant calls {tool}" for tool in t.ground_truth)
    return texts


def vectorize_trace(trace: Trace, embedder: Embedder, flag_weight: float = 0.5) -> VectorizedTrace:
    texts = [serialize_event(ev) for ev in trace.events]
    embeddings = embedder.encode(texts)  # (n, 384)
    flags = np.stack([structural_flags(ev, trace) for ev in trace.events])  # (n, 6)
    vectors = np.concatenate([embeddings, flags * flag_weight], axis=1)  # (n, 390)
    return VectorizedTrace(trace=trace, vectors=vectors.astype(np.float32))


def vectorize_ground_truth(gt_tools: list[str], embedder: Embedder) -> np.ndarray:
    """
    정답 시퀀스는 인자/타이밍 정보가 없으므로 '함수 호출' 형태로만 직렬화하고
    구조 플래그는 전부 0으로 둔다 (GT 자체의 위치 정보는 의미가 없기 때문).
    """
    texts = [f"assistant calls {tool}" for tool in gt_tools]
    embeddings = embedder.encode(texts)
    flags = np.zeros((len(gt_tools), FLAG_DIM), dtype=np.float32)
    return np.concatenate([embeddings, flags], axis=1).astype(np.float32)
