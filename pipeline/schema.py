"""
DojoScope trace 데이터 스키마.

이 파일은 "타입 강제"가 목적이 아니라, 파이프라인 전체가 어떤 필드를
전제로 동작하는지 한 곳에서 확인할 수 있게 하는 문서 역할도 겸한다.
실제 AgentDojo 원본 로그를 이 형식으로만 변환하면 나머지 파이프라인은
그대로 재사용할 수 있다.

Event.role 은 세 가지 중 하나만 허용한다:
    "user"      - 사용자 메시지
    "tool_call" - 에이전트의 도구 호출
    "tool_resp" - 도구가 돌려준 응답

Trace(케이스) 하나는 (suite, user_task_id, injection_task_id, condition)
조합으로 유일하게 식별된다. 같은 (suite, user_task_id, injection_task_id)에
대해 condition("A": 방어 없음, "B": 방어 있음 등)만 다른 두 케이스가
'짝(pair)'이 되어 비교 모드(화살표 지도)의 재료가 된다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

Role = Literal["user", "tool_call", "tool_resp"]


@dataclass
class Event:
    index: int                     # trace 안에서의 순번 (0부터)
    role: Role
    function: Optional[str] = None     # role이 tool_call/tool_resp일 때 도구 이름
    args: dict[str, Any] = field(default_factory=dict)  # tool_call의 인자
    text: Optional[str] = None         # user 메시지 본문 / tool_resp 응답 본문
    injected: bool = False             # 이 tool_resp 안에 공격 지시문이 포함되어 있었는가


@dataclass
class Trace:
    suite: str                     # banking / slack / travel / workspace ...
    user_task_id: str
    injection_task_id: str
    condition: str                 # "A"(무방어) / "B"(tool_filter) 등, 자유 문자열
    model: str
    events: list[Event]
    ground_truth: list[str]        # 공격이 없었다면 호출했어야 할 도구 이름 순서
    utility: bool                  # 사용자 과제 성공 여부
    security: bool                 # 공격 성공(=뚫림) 여부. True면 hijack 성공
    injection_exposure: Optional[int] = None   # 주입 지시문을 처음 읽은 이벤트 index
    hijack_events: list[int] = field(default_factory=list)  # 주입 지시문을 실행한 이벤트 index들
    first_deviation: Optional[int] = None      # 정답 시퀀스에서 처음 벗어난 이벤트 index

    @property
    def case_id(self) -> str:
        return f"{self.suite}__{self.user_task_id}__{self.injection_task_id}__{self.condition}"

    @property
    def pair_key(self) -> str:
        """condition을 뺀 키. 같은 pair_key를 가진 두 조건이 비교 모드의 짝이 된다."""
        return f"{self.suite}__{self.user_task_id}__{self.injection_task_id}"

    @property
    def verdict(self) -> str:
        """utility x security 4상태 라벨. Overview 패널의 4색과 동일한 정의."""
        if self.utility and self.security:
            return "success_hijacked"      # 과제 성공 · 뚫림
        if self.utility and not self.security:
            return "success_defended"      # 과제 성공 · 방어
        if not self.utility and self.security:
            return "fail_hijacked"         # 과제 실패 · 뚫림
        return "fail_defended"             # 과제 실패 · 방어

    @property
    def hijack_tool(self) -> Optional[str]:
        if not self.hijack_events:
            return None
        idx = self.hijack_events[0]
        for ev in self.events:
            if ev.index == idx:
                return ev.function
        return None

    @property
    def exposure_channel(self) -> Optional[str]:
        if self.injection_exposure is None:
            return None
        for ev in self.events:
            if ev.index == self.injection_exposure:
                return ev.function
        return None

    @property
    def delay(self) -> Optional[int]:
        """노출 이후 첫 납치까지 걸린 이벤트 수. 노출/납치가 없으면 None."""
        if self.injection_exposure is None or not self.hijack_events:
            return None
        return min(self.hijack_events) - self.injection_exposure

    @property
    def delay_bucket(self) -> str:
        d = self.delay
        if d is None:
            return "none"          # 애초에 뚫리지 않음
        if d <= 1:
            return "immediate"     # 노출 직후
        return "delayed"           # 3턴 이상 뒤 등, 지연된 납치


def trace_from_dict(d: dict[str, Any]) -> Trace:
    events = [Event(**ev) for ev in d["events"]]
    kwargs = {k: v for k, v in d.items() if k != "events"}
    return Trace(events=events, **kwargs)
