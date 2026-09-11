"""pipeline/gt_align.py 테스트.

이벤트 벡터를 직접 구성해 두 극단 상황을 확인한다:
1. trace가 GT와 완전히 같은 방향의 벡터로만 구성되어 있으면 전부 매칭되어야
   한다 (잔차가 비어 있어야 함).
2. trace가 GT와 완전히 다른(직교하는) 벡터로만 구성되어 있으면 아무것도
   매칭되지 않아야 한다 (전부 잔차).

calibrate_tau는 실제 vectorize 결과 없이도, VectorizedTrace를 흉내 낸 간단한
더미 객체로 "같은 함수 호출은 가깝고 다른 함수 호출은 멀 때 그 중간값을
고른다"는 핵심 동작만 검증한다.
"""

from dataclasses import dataclass

import numpy as np

from pipeline.gt_align import align_to_ground_truth, calibrate_tau
from pipeline.schema import Event, Trace


def test_perfect_match_leaves_no_residual():
    gt = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32)
    events = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32)  # GT와 완전히 동일
    result = align_to_ground_truth(events, gt, tau=0.1)
    assert result.matched_to_gt == [True, True]
    assert result.residual_indices == []


def test_orthogonal_events_are_entirely_residual():
    gt = np.array([[1, 0, 0], [0, 1, 0]], dtype=np.float32)
    events = np.array([[0, 0, 1], [0, 0, 1]], dtype=np.float32)  # GT와 직교(코사인 거리=1)
    result = align_to_ground_truth(events, gt, tau=0.35)
    assert result.matched_to_gt == [False, False]
    assert result.residual_indices == [0, 1]


def test_empty_event_sequence_returns_empty_result():
    gt = np.array([[1, 0]], dtype=np.float32)
    empty = np.zeros((0, 2), dtype=np.float32)
    result = align_to_ground_truth(empty, gt, tau=0.35)
    assert result.matched_to_gt == []
    assert result.residual_indices == []


@dataclass
class _DummyVT:
    trace: Trace
    vectors: np.ndarray


def _dummy_trace_with_two_calls():
    events = [
        Event(index=0, role="tool_call", function="func_a"),
        Event(index=1, role="tool_call", function="func_b"),
    ]
    return Trace(
        suite="test", user_task_id="u0", injection_task_id="i0", condition="A", model="m",
        events=events, ground_truth=["func_a", "func_b"], utility=True, security=False,
    )


def test_calibrate_tau_falls_between_same_and_different_function_distances():
    trace = _dummy_trace_with_two_calls()
    # func_a는 항상 [1,0] 방향, func_b는 항상 [0,1] 방향 (완전히 분리된 두 클러스터)
    vt = _DummyVT(trace=trace, vectors=np.array([[1, 0], [0, 1]], dtype=np.float32))
    gt_vectors_by_case = {trace.case_id: np.array([[1, 0], [0, 1]], dtype=np.float32)}

    tau = calibrate_tau([vt], gt_vectors_by_case)
    # same-function 거리는 0에 가깝고, different-function 거리는 1에 가까우므로
    # 그 중간(약 0.5) 근방이어야 하고, 적어도 0과 1 사이여야 한다.
    assert 0.0 < tau < 1.0


def test_calibrate_tau_falls_back_to_default_when_no_signal():
    trace = _dummy_trace_with_two_calls()
    # func_a, func_b 모두 같은 벡터 -> same/diff가 분리되지 않음 -> 기본값으로 후퇴
    vt = _DummyVT(trace=trace, vectors=np.array([[1, 0], [1, 0]], dtype=np.float32))
    gt_vectors_by_case = {trace.case_id: np.array([[1, 0], [1, 0]], dtype=np.float32)}

    tau = calibrate_tau([vt], gt_vectors_by_case, default=0.35)
    assert tau == 0.35
