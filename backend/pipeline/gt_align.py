"""
PDF 3단계 "정답 · 조건 A · 조건 B, 세 줄 정렬"과 4단계 잔차 계산을 구현한다.

절차:
  1. trace 벡터 시퀀스를 GT 벡터 시퀀스와 DTW로 정렬한다.
  2. 정렬 경로에서 코사인 거리가 tau(임계값) 이하인 짝만 "GT와 매칭됨"으로 본다.
     (DTW는 항상 뭔가를 짝지어 주므로, 짝이 있다고 다 매칭은 아니다 -- 거리가
     너무 크면 "짝지어졌을 뿐 사실은 다른 행동"이라고 판단한다.)
  3. GT와 매칭되지 않은 이벤트만 모은 것이 잔차(residual) 시퀀스다.

tau 기본값 0.35는 PDF 8장 실험에서 사용한 값을 그대로 따른다.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

import numpy as np

from .dtw import dtw_distance

DEFAULT_TAU = 0.35


@dataclass
class AlignmentResult:
    matched_to_gt: list[bool]      # 이벤트별로 GT와 매칭됐는지 (len == n_events)
    gt_index_of_event: list[int | None]  # 매칭됐다면 어떤 GT 인덱스와 짝지어졌는지
    residual_indices: list[int]    # matched_to_gt가 False인 이벤트의 index 목록


def align_to_ground_truth(event_vectors: np.ndarray, gt_vectors: np.ndarray, tau: float = DEFAULT_TAU) -> AlignmentResult:
    n = len(event_vectors)
    if n == 0:
        return AlignmentResult(matched_to_gt=[], gt_index_of_event=[], residual_indices=[])

    result = dtw_distance(event_vectors, gt_vectors)

    # 이벤트(a축) 인덱스별로, 매칭된 gt 인덱스 중 로컬 코사인 거리가 가장 작은 것을 채택
    best_gt_for_event: dict[int, tuple[int, float]] = {}
    for a_idx, b_idx in result.path:
        d = float(result.cost_matrix[a_idx, b_idx]) if result.cost_matrix.size else np.inf
        if a_idx not in best_gt_for_event or d < best_gt_for_event[a_idx][1]:
            best_gt_for_event[a_idx] = (b_idx, d)

    matched_to_gt = [False] * n
    gt_index_of_event: list[int | None] = [None] * n
    for a_idx, (b_idx, d) in best_gt_for_event.items():
        if d <= tau:
            matched_to_gt[a_idx] = True
            gt_index_of_event[a_idx] = b_idx

    residual_indices = [i for i in range(n) if not matched_to_gt[i]]
    return AlignmentResult(
        matched_to_gt=matched_to_gt,
        gt_index_of_event=gt_index_of_event,
        residual_indices=residual_indices,
    )


def build_argument_majority_reference(traces: list) -> dict[tuple[str, str], tuple[str, float]]:
    """(function, arg_key) -> (최빈값, 그 값이 차지하는 비중).

    존재(함수 이름) 매칭만으로는 "이미 정답 시퀀스에 있는 도구를 재사용하되
    인자만 악성으로 바꾸는" 공격을 놓친다 — GT 벡터화가 함수 이름만 담고
    인자는 비교 대상에 없기 때문이다(align_to_ground_truth 참고). 실제
    케이스별 정답 인자(AgentDojo의 ground_truth(environment) 호출, 즉
    "클린런")가 있다면 그걸 기준으로 삼아야 하지만, 지금 이 파이프라인엔
    그 데이터 소스가 없다. 대신 suite 전체에서 그 함수가 실제로 어떤 인자로
    가장 많이 불렸는지(다수결)를 근사로 쓴다.

    이 근사의 한계는 이미 실측으로 확인했다(pipeline_study/
    argument_residual_diagnostic.py) — suite 전체에 정상 인자값이 사실상
    고정값 몇 개뿐인 데이터에서는 다수결이 잘 통하지만, 케이스마다 정상
    인자가 원래 다른 실제 데이터에서는 다수결 자체가 무의미해진다. 그래서
    이 함수가 만드는 신호는 "확정 판정"이 아니라 "참고 신호"로만 쓰고,
    min_share로 다수결 근거가 약할 때(과반 미만)는 판정을 보류한다.
    """
    counters: dict[tuple[str, str], dict[str, int]] = {}
    for t in traces:
        for ev in t.events:
            if ev.role != "tool_call" or not ev.function:
                continue
            for k, v in (ev.args or {}).items():
                bucket = counters.setdefault((ev.function, k), {})
                bucket[str(v)] = bucket.get(str(v), 0) + 1

    ref: dict[tuple[str, str], tuple[str, float]] = {}
    for key, counts in counters.items():
        total = sum(counts.values())
        value, count = max(counts.items(), key=lambda kv: kv[1])
        ref[key] = (value, count / total)
    return ref


def compute_arg_mismatch(trace, matched_to_gt: list[bool], majority_ref: dict, min_share: float = 0.5) -> list[bool]:
    """이벤트별로 "함수는 GT와 매칭됐지만 인자가 다수결 값과 다른"(=인자
    재사용형 공격일 가능성) 이벤트를 표시한다. existence residual이
    이미 잡아낸 이벤트(matched_to_gt=False)는 건드리지 않는다 — 거기 더
    보탤 정보가 없다."""
    flags: list[bool] = []
    for i, ev in enumerate(trace.events):
        mismatch = False
        if i < len(matched_to_gt) and matched_to_gt[i] and ev.role == "tool_call" and ev.function:
            for k, v in (ev.args or {}).items():
                ref = majority_ref.get((ev.function, k))
                if ref is not None and ref[1] >= min_share and str(v) != ref[0]:
                    mismatch = True
        flags.append(mismatch)
    return flags


def compute_arg_mismatch_details(trace, matched_to_gt: list[bool], majority_ref: dict, min_share: float = 0.5) -> list[dict]:
    """compute_arg_mismatch와 같은 판정을 쓰되, "다르다"만이 아니라 "무엇이
    기대값이고 무엇이 실제값인지"까지 이벤트별로 담는다 — "injection이
    없었다면 이 자리에 어떤 인자가 있었을지"를 화면에 직접 보여주기 위해
    필요하다. 반환값: 이벤트별 {인자키: {actual, expected, expected_share}}
    (불일치가 없으면 빈 dict)."""
    details: list[dict] = []
    for i, ev in enumerate(trace.events):
        d: dict = {}
        if i < len(matched_to_gt) and matched_to_gt[i] and ev.role == "tool_call" and ev.function:
            for k, v in (ev.args or {}).items():
                ref = majority_ref.get((ev.function, k))
                if ref is not None and ref[1] >= min_share and str(v) != ref[0]:
                    d[k] = {"actual": v, "expected": ref[0], "expected_share": round(ref[1], 3)}
        details.append(d)
    return details


def _cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) + 1e-12
    return float(max(0.0, 1.0 - float(a @ b) / denom))


def calibrate_tau(vtraces: list, gt_vectors_by_case: dict[str, np.ndarray], default: float = DEFAULT_TAU) -> float:
    """
    GT 매칭 임계값 tau를 고정값으로 쓰지 않고, 현재 임베딩 백엔드·suite에 맞춰
    데이터로부터 자동 보정한다.

    이유: PDF 8장의 tau=0.35는 저자들이 bge-small-en-v1.5 임베딩에서 실험으로
    찾은 값이다. 임베딩 방식이 다르면(예: 이 프로젝트의 TF-IDF+SVD 폴백) 코사인
    거리의 절대적인 스케일 자체가 달라지므로, 다른 임베딩 백엔드에 같은 tau를
    그대로 적용하는 것은 방법론적으로 근거가 없다 — 실제로 이 프로젝트에서
    실험적으로 확인했다 (LSA 임베딩에서는 정답과 "같은 함수 호출"의 거리조차
    0.35를 넘는 경우가 많았다).

    방법: suite 안에서 실제로 나타나는 함수 이름마다, "그 함수를 부른 실제
    이벤트" 표본과 "그 함수의 GT 벡터"(같은 함수) 사이 거리를 same-class,
    "다른 함수의 GT 벡터"와의 거리를 different-class로 모아 두 그룹 평균의
    중간값을 tau로 삼는다 (이분 판별의 표준적인 방법 — Otsu 임계값 선택과
    같은 원리를 두 그룹 평균에 적용한 것).
    """
    by_func_vecs: dict[str, list[np.ndarray]] = {}
    for vt in vtraces:
        for i, ev in enumerate(vt.trace.events):
            if ev.role == "tool_call" and ev.function:
                by_func_vecs.setdefault(ev.function, []).append(vt.vectors[i])

    func_to_gt_vec: dict[str, np.ndarray] = {}
    for vt in vtraces:
        gt_vecs = gt_vectors_by_case.get(vt.trace.case_id)
        if gt_vecs is None:
            continue
        for name, vec in zip(vt.trace.ground_truth, gt_vecs):
            func_to_gt_vec.setdefault(name, vec)

    rng = random.Random(42)
    same_d: list[float] = []
    diff_d: list[float] = []
    for func, vecs in by_func_vecs.items():
        gt_v = func_to_gt_vec.get(func)
        if gt_v is None:
            continue
        for v in vecs:
            same_d.append(_cosine_distance(v, gt_v))
        others = [g for g in func_to_gt_vec if g != func]
        if others:
            for v in vecs[:8]:  # suite당 계산량을 억제하기 위한 표본 상한
                other_gt = func_to_gt_vec[rng.choice(others)]
                diff_d.append(_cosine_distance(v, other_gt))

    if not same_d or not diff_d:
        return default
    same_mean = sum(same_d) / len(same_d)
    diff_mean = sum(diff_d) / len(diff_d)
    if diff_mean <= same_mean + 1e-6:  # same/diff가 분리되지 않으면 기본값으로 후퇴
        return default
    return float((same_mean + diff_mean) / 2)
