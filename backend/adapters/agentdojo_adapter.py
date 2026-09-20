#!/usr/bin/env python3
"""
실제 AgentDojo 벤치마크 로그를 DojoScope의 trace 스키마(pipeline/schema.py의
Trace/Event, README.md "데이터 포맷" 절)로 변환하는 어댑터.

AgentDojo가 실제로 로그를 남기는 방식(ethz-spylab/agentdojo, agentdojo.logging.TraceLogger
및 agentdojo.benchmark.load_task_results 확인 결과, 2026-09 기준 main 브랜치):

    python -m agentdojo.scripts.benchmark --logdir runs ...
    (또는 벤치마크를 코드로 직접 돌릴 때도 OutputLogger/TraceLogger가 같은 경로 규칙을 씀)

실행하면 아래 경로 규칙으로 케이스 하나당 JSON 파일 하나가 쌓인다:

    <logdir>/<pipeline_name>/<suite_name>/<user_task_id>/<attack_name>/<injection_task_id>.json

파일 하나의 내용(TaskResults/TraceLogger가 저장하는 필드):
    suite_name, pipeline_name, user_task_id, injection_task_id, attack_type,
    injections(dict: 주입 벡터 이름 -> 주입된 텍스트), utility(bool), security(bool),
    messages(대화 전체), duration, evaluation_timestamp, agentdojo_package_version, error

주의(우리 스키마와의 결정적인 차이 두 가지):

  1. security의 의미가 "반대"다. AgentDojo의 security=True는 "공격이 실패해서 안전했다"는
     뜻인데, 우리 스키마(pipeline/schema.py)의 security=True는 "뚫렸다(공격 성공)"는 뜻이다.
     그대로 옮기면 방어 성공/실패가 뒤집히므로 반드시 not agentdojo_security로 반전한다.
  2. 정답 시퀀스(ground_truth)는 이 로그 파일 안에 들어 있지 않다. AgentDojo는 이걸
     `user_task.ground_truth(pre_environment)`를 그때그때 호출해서 얻는데, 이는 벤치마크
     환경 객체 재구성이 필요해 로그만으로는 재현할 수 없다. 대신 같은 (suite, user_task)의
     "공격 없음" 기준 실행(attack_type == "none", agentdojo.benchmark의
     benchmark_suite_without_injections가 남기는 로그)에서 실제로 호출한 도구 이름 순서를
     ground_truth로 대신 쓴다 — 이는 우리 스키마 자체의 정의("공격이 없었다면 호출했어야
     할 도구 이름 순서")와 정확히 일치하는 근사이기도 하다. 이 기준 실행이 없으면
     ground_truth는 빈 리스트가 되고(파이프라인은 이 경우도 처리하지만 GT 정렬/잔차 계산이
     의미를 잃는다), --agentdojo-ground-truth 옵션으로 실제 agentdojo 패키지가 설치되어
     있으면 정확한 ground_truth()를 직접 호출하도록 확장할 수 있는 지점을 남겨 두었다
     (AGENTDOJO_AVAILABLE 분기, 현재는 미구현 — 환경 재구성 로직이 필요해 다음 확장으로 남김).

사용법:
    python adapters/agentdojo_adapter.py /path/to/runs -o converted.json
    python adapters/agentdojo_adapter.py /path/to/runs -o converted.json --pipeline gpt-4o-2024-05-13
    # 그 다음 변환된 JSON을 서버에 업로드:
    curl -F "file=@converted.json" http://<서버>:8000/api/upload
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Optional

# 알려진 AgentDojo 방어(defense) 파이프라인 이름 — pipeline_name에 이 문자열이 들어 있으면
# "무방어(A)"가 아니라 해당 방어 이름을 condition으로 쓴다. AgentDojo 리더보드/논문 기준
# 명명 규칙(예: "gpt-4o-2024-05-13-tool_filter")을 따른다. 새 방어가 추가되면 이 목록만
# 늘리면 된다 — 목록에 없는 접미사는 무시되고 pipeline_name 전체가 condition이 된다.
KNOWN_DEFENSES = [
    "tool_filter", "transformers_pi_detector", "spotlighting_with_delimiting",
    "repeat_user_prompt", "important_instructions", "pi_detector",
]


def _text_from_content(content: Any) -> str:
    """ChatMessage의 content는 문자열이거나 MessageContentBlock(dict) 리스트일 수 있다
    (agentdojo.types의 TextContentBlock 등). 텍스트 블록만 이어붙인다."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("content") or "")
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(p for p in parts if p)
    return str(content)


def messages_to_events(messages: list[dict]) -> list[dict]:
    """agentdojo ChatMessage 목록 -> DojoScope Event 딕셔너리 목록.

    system 메시지는 모든 케이스에서 거의 동일(매 케이스 공통 지시문)해서 시퀀스 비교에
    잡음만 더하므로 제외한다. 최종 답변처럼 tool_call이 없는 assistant 텍스트 메시지는
    우리 스키마의 role enum(user/tool_call/tool_resp)에 대응점이 없어 이벤트 시퀀스에서는
    생략한다 — 이 변환에서 의미 있는 신호는 "어떤 도구를 어떤 순서로 불렀는가"이기
    때문이다(README §3 데이터 포맷 참고)."""
    events: list[dict] = []
    idx = 0
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            continue
        if role == "user":
            text = _text_from_content(msg.get("content"))
            events.append({"index": idx, "role": "user", "function": None, "args": {}, "text": text, "injected": False})
            idx += 1
        elif role == "assistant":
            for call in msg.get("tool_calls") or []:
                events.append({
                    "index": idx, "role": "tool_call",
                    "function": call.get("function"), "args": call.get("args") or {},
                    "text": None, "injected": False,
                })
                idx += 1
        elif role == "tool":
            call = msg.get("tool_call") or {}
            events.append({
                "index": idx, "role": "tool_resp",
                "function": call.get("function"), "args": {},
                "text": _text_from_content(msg.get("content")), "injected": False,
            })
            idx += 1
    return events


def _mark_injected(events: list[dict], injections: dict[str, str]) -> None:
    """injections dict(주입 벡터 이름 -> 주입된 텍스트)의 값이 tool_resp 텍스트 안에
    실제로 등장하는지로 injected 여부를 표시한다. 짧은/빈 문자열은 오탐 위험이 커서
    최소 길이 기준(20자)을 둔다."""
    needles = [v for v in injections.values() if isinstance(v, str) and len(v.strip()) >= 20]
    if not needles:
        return
    for ev in events:
        if ev["role"] != "tool_resp" or not ev.get("text"):
            continue
        if any(needle in ev["text"] for needle in needles):
            ev["injected"] = True


def _derive_condition(pipeline_name: str) -> str:
    for defense in KNOWN_DEFENSES:
        if defense in pipeline_name:
            return defense
    return "A"  # 알려진 방어 접미사가 없으면 "무방어" 기준선으로 본다


def _case_key(suite: str, user_task: str, injection_task: str, condition: str) -> str:
    return f"{suite}__{user_task}__{injection_task}__{condition}"


def build_trace_dict(
    raw: dict,
    ground_truth: list[str],
    condition_source: str,
) -> dict:
    events = messages_to_events(raw.get("messages") or [])
    injections = raw.get("injections") or {}
    _mark_injected(events, injections)

    pipeline_name = raw.get("pipeline_name", "")
    if condition_source == "attack":
        condition = raw.get("attack_type") or "A"
    elif condition_source == "pipeline":
        condition = _derive_condition(pipeline_name)
    else:
        condition = pipeline_name or "A"

    # injection_exposure: injected=True로 표시된 첫 tool_resp 이벤트의 index.
    injection_exposure = next((ev["index"] for ev in events if ev.get("injected")), None)

    # first_deviation: tool_call 이벤트들을 등장 순서대로 ground_truth와 위치별로 비교해서
    # 처음 어긋나는 지점. GT가 비어 있으면(기준 실행을 못 찾음) 계산할 수 없다.
    first_deviation = None
    tool_call_events = [ev for ev in events if ev["role"] == "tool_call"]
    if ground_truth:
        for i, ev in enumerate(tool_call_events):
            expected = ground_truth[i] if i < len(ground_truth) else None
            if ev.get("function") != expected:
                first_deviation = ev["index"]
                break

    # hijack_events: 노출(injection_exposure) 이후에 일어난 "정답과 다른" tool_call들.
    # first_deviation 이후의 도구 호출이라는 더 직접적인 근사를 쓴다(정답 시퀀스 자체가
    # 한 스텝 밀리면 이후 전부 "다르다"고 나오는 DTW 매칭의 미묘함은 서버 쪽
    # gt_align.align_to_ground_truth가 다시 정교하게 계산하므로, 여기서는 대략적인
    # 힌트만 채워 둔다).
    hijack_events: list[int] = []
    if injection_exposure is not None:
        threshold = first_deviation if first_deviation is not None else injection_exposure
        hijack_events = [
            ev["index"] for ev in tool_call_events
            if ev["index"] >= threshold and ev["index"] >= injection_exposure
        ]

    security_hijacked = not bool(raw.get("security"))  # AgentDojo: True=안전 -> 우리 스키마: 반전

    return {
        "suite": raw["suite_name"],
        "user_task_id": raw["user_task_id"],
        "injection_task_id": raw["injection_task_id"],
        "condition": condition,
        "model": pipeline_name,
        "events": events,
        "ground_truth": ground_truth,
        "utility": bool(raw.get("utility")),
        "security": security_hijacked,
        "injection_exposure": injection_exposure,
        "hijack_events": hijack_events,
        "first_deviation": first_deviation,
    }


def _load_all(logdir: Path) -> list[dict]:
    raws = []
    for path in logdir.rglob("*.json"):
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if {"suite_name", "user_task_id", "injection_task_id", "messages"}.issubset(d.keys()):
            raws.append(d)
    return raws


def convert(logdir: Path, condition_source: str = "pipeline", pipeline_filter: Optional[str] = None) -> list[dict]:
    raws = _load_all(logdir)
    if pipeline_filter:
        raws = [r for r in raws if r.get("pipeline_name") == pipeline_filter]
    if not raws:
        print(f"[agentdojo_adapter] 경고: {logdir} 아래에서 TraceLogger 형식 JSON을 하나도 찾지 못했습니다.", file=sys.stderr)
        return []

    # (suite, user_task) -> attack_type == "none" 기준 실행의 tool_call 함수 이름 순서.
    gt_by_task: dict[tuple[str, str], list[str]] = {}
    for r in raws:
        if r.get("attack_type") in (None, "none"):
            key = (r["suite_name"], r["user_task_id"])
            events = messages_to_events(r.get("messages") or [])
            gt_by_task[key] = [ev["function"] for ev in events if ev["role"] == "tool_call"]

    missing_gt: set[tuple[str, str]] = set()
    out_by_key: dict[str, dict] = {}
    for r in raws:
        if r.get("attack_type") in (None, "none"):
            continue  # 기준 실행 자체는 케이스로 내보내지 않는다 (공격이 없는 트레이스는 비교 대상이 아님)
        key = (r["suite_name"], r["user_task_id"])
        gt = gt_by_task.get(key)
        if gt is None:
            missing_gt.add(key)
            gt = []
        trace = build_trace_dict(r, gt, condition_source)
        case_key = _case_key(trace["suite"], trace["user_task_id"], trace["injection_task_id"], trace["condition"])
        out_by_key[case_key] = trace  # 같은 키가 여러 개면(재실행 등) 마지막 것으로 덮어씀

    if missing_gt:
        print(f"[agentdojo_adapter] 경고: {len(missing_gt)}개 (suite, user_task)에 대해 "
              f"attack_type='none' 기준 실행을 찾지 못해 ground_truth=[]로 둡니다 — "
              f"benchmark_suite_without_injections()를 먼저 돌려서 기준 로그를 남겨 두세요.",
              file=sys.stderr)
        for suite, task in sorted(missing_gt):
            print(f"    - {suite} / {task}", file=sys.stderr)

    return list(out_by_key.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logdir", type=Path, help="AgentDojo --logdir 로 지정했던 디렉터리 (예: runs/)")
    parser.add_argument("-o", "--output", type=Path, default=Path("agentdojo_converted.json"))
    parser.add_argument("--pipeline", default=None, help="특정 pipeline_name만 변환(예: 여러 모델을 한 logdir에 같이 돌린 경우)")
    parser.add_argument("--condition-source", choices=["pipeline", "attack", "raw-pipeline"], default="pipeline",
                         help="condition(A/B 비교축)을 무엇으로 정할지. "
                              "'pipeline'(기본)=pipeline_name에서 알려진 방어 접미사를 인식, "
                              "'attack'=attack_type을 그대로 씀, 'raw-pipeline'=pipeline_name 전체를 그대로 씀")
    args = parser.parse_args()

    if not args.logdir.exists():
        print(f"오류: {args.logdir} 없음", file=sys.stderr)
        sys.exit(1)

    cases = convert(args.logdir, condition_source=args.condition_source, pipeline_filter=args.pipeline)
    if not cases:
        print("변환된 케이스가 없습니다.", file=sys.stderr)
        sys.exit(1)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(cases, f, ensure_ascii=False)
    print(f"[agentdojo_adapter] {len(cases)}건 변환 완료 -> {args.output}")
    print(f"[agentdojo_adapter] 업로드: curl -F \"file=@{args.output}\" http://<서버>:8000/api/upload")


if __name__ == "__main__":
    main()
