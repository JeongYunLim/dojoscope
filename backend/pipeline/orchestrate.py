"""
run_pipeline.py(CLI)와 server.py(라이브 서버)가 공통으로 쓰는 오케스트레이션 함수.
"trace 목록을 받아서 suite별 출력 dict를 만든다"는 하나의 책임만 갖는다 —
파일 입출력은 호출하는 쪽(CLI는 디스크에 저장, 서버는 메모리에 캐시)이 맡는다.
"""

from __future__ import annotations

from collections import defaultdict

from .build_output import build_suite_output
from .schema import Trace
from .vectorize import Embedder, collect_corpus


def compute_all_suites(
    traces: list[Trace],
    flag_weight: float = 0.5,
    tau: float | None = None,
    residual_mode: str = "all",
    model_name: str = "BAAI/bge-small-en-v1.5",
    seed: int = 42,
    n_clusters: int | None = None,
    on_progress=None,
) -> tuple[dict[str, dict], str]:
    """전체 trace 목록을 받아 suite별 출력 JSON(dict)을 계산한다.

    on_progress(message: str)가 주어지면 suite 하나를 끝낼 때마다 호출한다.
    server.py가 이걸로 터미널에 진행 상황을 찍어서, 계산이 오래 걸릴 때도
    "멈춘 건지 진행 중인 건지" 알 수 있게 한다.

    반환값: (suite_name -> output_dict, 사용된 임베딩 백엔드 이름)
    """
    by_suite: dict[str, list[Trace]] = defaultdict(list)
    for t in traces:
        by_suite[t.suite].append(t)

    embedder = Embedder(model_name=model_name, seed=seed)
    embedder.fit(collect_corpus(traces))  # LSA 경로일 때만 의미 있음
    if on_progress:
        on_progress(f"임베딩 준비 완료 (backend={embedder.backend}), suite {len(by_suite)}개 계산 시작")

    outputs: dict[str, dict] = {}
    for suite_name, suite_traces in by_suite.items():
        outputs[suite_name] = build_suite_output(
            suite_name, suite_traces, embedder,
            flag_weight=flag_weight, tau=tau,
            residual_mode=residual_mode, seed=seed,
            n_clusters=n_clusters,
        )
        if on_progress:
            on_progress(f"suite '{suite_name}' 계산 완료 ({len(suite_traces)}건)")
    return outputs, embedder.backend
