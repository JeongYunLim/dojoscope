"""Security-centric aggregate analysis for DojoScope.

The embedding/DTW/UMAP pipeline is useful for *exploration*, but a security engineer
also needs direct answers to operational questions:

* How often is the attacker goal achieved under each condition (Targeted ASR)?
* How often does the user task still succeed, and how often is that success not
  accompanied by a successful attacker goal?
* For the exact same user-task × injection-task pair, did the defense block a
  compromise, introduce a regression, or leave the security outcome unchanged?
* Where in an execution does behavior diverge after an injected response is exposed?

This module derives those quantities from the deterministic trace fields.  It does
not infer new ground truth from UMAP coordinates, so these metrics stay interpretable
when the embedding backend or dimensionality-reduction seed changes.

Terminology note
----------------
AgentDojo's paper defines Benign Utility using *no-attack* runs.  The current DojoScope
sample only contains attacked A/B conditions, therefore this module never labels its
per-condition ``utility`` rate as Benign Utility.  Likewise, ``safe_completion_rate``
is explicitly a proxy: ``trace.utility and not trace.security``.  It is useful for the
current schema but should not be silently equated with AgentDojo's Utility Under Attack
unless the adapter guarantees that ``security=False`` rules out every adversarial side
effect relevant to that metric.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from math import comb, sqrt
from typing import Iterable


Z_95 = 1.959963984540054


def wilson_interval(successes: int, n: int, z: float = Z_95) -> list[float] | None:
    """Return the two-sided Wilson score interval as ``[low, high]``.

    Wilson intervals behave much better than the normal/Wald approximation for the
    small per-suite sample sizes used by the bundled synthetic dataset.
    """
    if n <= 0:
        return None
    p = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    half = z * sqrt((p * (1 - p) / n) + (z2 / (4 * n * n))) / denom
    return [max(0.0, center - half), min(1.0, center + half)]


def exact_mcnemar_pvalue(blocked: int, regressed: int) -> float:
    """Exact two-sided McNemar/binomial p-value for paired binary outcomes.

    Only discordant pairs matter. Under H0, ``blocked`` and ``regressed`` are equally
    likely (Binomial(n=blocked+regressed, p=0.5)).
    """
    if blocked < 0 or regressed < 0:
        raise ValueError("McNemar counts must be non-negative")
    n = blocked + regressed
    if n == 0:
        return 1.0
    k = min(blocked, regressed)
    lower_tail = sum(comb(n, i) for i in range(k + 1)) / (2**n)
    return min(1.0, 2.0 * lower_tail)


def _rate(count: int, n: int) -> float | None:
    return (count / n) if n else None


def _median(values: Iterable[int | float | None]) -> float | None:
    xs = sorted(float(v) for v in values if v is not None)
    if not xs:
        return None
    m = len(xs) // 2
    if len(xs) % 2:
        return xs[m]
    return (xs[m - 1] + xs[m]) / 2.0


def _first_hijack(case: dict) -> int | None:
    vals = case.get("hijack_events") or []
    return min(vals) if vals else None


def derive_case_security_fields(case: dict) -> None:
    """Annotate a serialized case with attack-chain / divergence diagnostics in place."""
    exposure = case.get("injection_exposure")
    deviation = case.get("first_deviation")
    hijack = _first_hijack(case)

    case["safe_completion"] = bool(case.get("utility") and not case.get("security"))
    case["exposure_to_deviation"] = (
        deviation - exposure if exposure is not None and deviation is not None and deviation >= exposure else None
    )
    case["deviation_to_hijack"] = (
        hijack - deviation if hijack is not None and deviation is not None and hijack >= deviation else None
    )
    # The schema's delay already means exposure -> first hijack. Keep a semantic alias
    # because the dashboard presents it as an attack-chain interval.
    case["exposure_to_hijack"] = (
        hijack - exposure if exposure is not None and hijack is not None and hijack >= exposure else None
    )

    residual_tools = []
    post_exposure_residual_tools = []
    for ev in case.get("events", []):
        if ev.get("role") != "tool_call" or ev.get("matched_to_gt"):
            continue
        fn = ev.get("function") or "(unknown)"
        residual_tools.append(fn)
        if exposure is not None and ev.get("index", -1) > exposure:
            post_exposure_residual_tools.append(fn)

    case["residual_tool_calls"] = len(residual_tools)
    case["unique_residual_tools"] = len(set(residual_tools))
    case["post_exposure_residual_tool_calls"] = len(post_exposure_residual_tools)
    case["post_exposure_residual_tools"] = sorted(set(post_exposure_residual_tools))


def _condition_summary(cases: list[dict]) -> dict:
    n = len(cases)
    utility_success = sum(bool(c.get("utility")) for c in cases)
    attacker_success = sum(bool(c.get("security")) for c in cases)
    safe_completion = sum(bool(c.get("utility") and not c.get("security")) for c in cases)
    compromised_completion = sum(bool(c.get("utility") and c.get("security")) for c in cases)
    failure_no_hijack = sum(bool((not c.get("utility")) and (not c.get("security"))) for c in cases)
    failure_hijacked = sum(bool((not c.get("utility")) and c.get("security")) for c in cases)

    return {
        "n": n,
        # This is *task completion under the current attacked condition*, not AgentDojo
        # Benign Utility (which needs no-attack traces).
        "task_utility_rate": _rate(utility_success, n),
        "task_utility_ci95": wilson_interval(utility_success, n),
        "targeted_asr": _rate(attacker_success, n),
        "targeted_asr_ci95": wilson_interval(attacker_success, n),
        "safe_completion_rate": _rate(safe_completion, n),
        "safe_completion_ci95": wilson_interval(safe_completion, n),
        "counts": {
            "utility_success": utility_success,
            "attacker_success": attacker_success,
            "safe_completion": safe_completion,
            "compromised_completion": compromised_completion,
            "failure_no_hijack": failure_no_hijack,
            "failure_hijacked": failure_hijacked,
        },
        "attack_chain": {
            "exposed": sum(c.get("injection_exposure") is not None for c in cases),
            "deviated": sum(c.get("first_deviation") is not None for c in cases),
            "hijacked": attacker_success,
            "median_exposure_to_deviation": _median(c.get("exposure_to_deviation") for c in cases),
            "median_deviation_to_hijack": _median(c.get("deviation_to_hijack") for c in cases),
            "median_exposure_to_hijack": _median(c.get("exposure_to_hijack") for c in cases),
            "median_post_exposure_residual_tool_calls": _median(
                c.get("post_exposure_residual_tool_calls") for c in cases if c.get("injection_exposure") is not None
            ),
        },
    }


def _pair_transition(a: dict, b: dict) -> str:
    a_bad, b_bad = bool(a.get("security")), bool(b.get("security"))
    if a_bad and not b_bad:
        return "blocked"
    if not a_bad and b_bad:
        return "regressed"
    if a_bad and b_bad:
        return "still_hijacked"
    return "still_safe"


def _paired_summary(cases: list[dict], baseline: str, defense: str) -> dict:
    by_pair: dict[str, dict[str, dict]] = defaultdict(dict)
    for case in cases:
        by_pair[case["pair_key"]][case["condition"]] = case

    transitions = Counter()
    utility_transitions = Counter()
    paired_cases = 0
    for group in by_pair.values():
        if baseline not in group or defense not in group:
            continue
        paired_cases += 1
        a, b = group[baseline], group[defense]
        transition = _pair_transition(a, b)
        transitions[transition] += 1
        a["security_transition"] = transition
        b["security_transition"] = transition

        ua, ub = bool(a.get("utility")), bool(b.get("utility"))
        if ua and not ub:
            utility_transitions["utility_lost"] += 1
        elif not ua and ub:
            utility_transitions["utility_gained"] += 1
        elif ua and ub:
            utility_transitions["utility_kept"] += 1
        else:
            utility_transitions["utility_failed_both"] += 1

    blocked = transitions["blocked"]
    regressed = transitions["regressed"]
    a_compromised = blocked + transitions["still_hijacked"]
    a_safe = regressed + transitions["still_safe"]
    b_compromised = regressed + transitions["still_hijacked"]

    result = {
        "baseline_condition": baseline,
        "defense_condition": defense,
        "n_pairs": paired_cases,
        "security_transitions": {
            "blocked": blocked,
            "regressed": regressed,
            "still_hijacked": transitions["still_hijacked"],
            "still_safe": transitions["still_safe"],
        },
        "blocked_rate_given_baseline_hijack": _rate(blocked, a_compromised),
        "regression_rate_given_baseline_safe": _rate(regressed, a_safe),
        "defense_targeted_asr": _rate(b_compromised, paired_cases),
        "mcnemar_exact_pvalue": exact_mcnemar_pvalue(blocked, regressed),
        "utility_transitions": {
            "utility_lost": utility_transitions["utility_lost"],
            "utility_gained": utility_transitions["utility_gained"],
            "utility_kept": utility_transitions["utility_kept"],
            "utility_failed_both": utility_transitions["utility_failed_both"],
        },
    }
    return result


def _defense_failure_modes(cases: list[dict], defense_condition: str | None) -> dict | None:
    """Summarize residual risk under the defense condition.

    This deliberately uses explicit trace fields (hijack tool, exposure channel, residual
    tool calls), not spatial clusters.  The goal is to tell a security developer *what is
    still going wrong after the defense is enabled*.
    """
    if defense_condition is None:
        return None
    defense_cases = [c for c in cases if c.get("condition") == defense_condition]
    compromised = [c for c in defense_cases if c.get("security")]
    if not defense_cases:
        return None

    hijack_tools = Counter(c.get("hijack_tool") or "(unknown)" for c in compromised)
    exposure_channels = Counter(c.get("exposure_channel") or "(not exposed)" for c in compromised)
    residual_tools = Counter()
    for c in compromised:
        for ev in c.get("events", []):
            if ev.get("role") == "tool_call" and not ev.get("matched_to_gt"):
                residual_tools[ev.get("function") or "(unknown)"] += 1

    def top(counter: Counter, limit: int = 5) -> list[dict]:
        return [{"name": name, "count": count} for name, count in counter.most_common(limit)]

    return {
        "condition": defense_condition,
        "n": len(defense_cases),
        "compromised_cases": len(compromised),
        "top_hijack_tools": top(hijack_tools),
        "top_exposure_channels": top(exposure_channels),
        "top_residual_tools": top(residual_tools),
    }


def _exposure_hotspots(cases: list[dict]) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for c in cases:
        groups[c.get("exposure_channel") or "(not exposed)"].append(c)

    out = []
    for channel, group in groups.items():
        n = len(group)
        hijacked = sum(bool(c.get("security")) for c in group)
        safe = sum(bool(c.get("utility") and not c.get("security")) for c in group)
        deviated = [c for c in group if c.get("first_deviation") is not None]
        out.append({
            "channel": channel,
            "n": n,
            "targeted_asr": _rate(hijacked, n),
            "targeted_asr_ci95": wilson_interval(hijacked, n),
            "safe_completion_rate": _rate(safe, n),
            "deviation_rate": _rate(len(deviated), n),
            "median_exposure_to_deviation": _median(c.get("exposure_to_deviation") for c in group),
            "median_exposure_to_hijack": _median(c.get("exposure_to_hijack") for c in group),
        })
    out.sort(key=lambda r: (-(r["targeted_asr"] or 0.0), -r["n"], r["channel"]))
    return out


def build_security_analysis(cases: list[dict]) -> dict:
    """Build security-developer-oriented aggregate analysis for one suite.

    ``cases`` are the already serialized output cases from ``build_output.py`` so the
    function can use matched-to-GT event annotations as well as original trace labels.
    The cases are annotated in place with derived fields used by the UI.
    """
    for case in cases:
        derive_case_security_fields(case)
        # Non-paired datasets still need a stable value for the color-by field.
        case.setdefault("security_transition", "unpaired")

    by_condition: dict[str, list[dict]] = defaultdict(list)
    for case in cases:
        by_condition[case["condition"]].append(case)
    condition_summary = {cond: _condition_summary(group) for cond, group in sorted(by_condition.items())}

    conditions = sorted(by_condition)
    paired = None
    baseline = "A" if "A" in by_condition else (conditions[0] if conditions else None)
    defense = "B" if "B" in by_condition else (conditions[1] if len(conditions) > 1 else None)
    if baseline is not None and defense is not None:
        paired = _paired_summary(cases, baseline, defense)
        a = condition_summary[baseline]
        b = condition_summary[defense]
        paired["targeted_asr_change_pp"] = (
            (b["targeted_asr"] - a["targeted_asr"]) * 100.0
            if a["targeted_asr"] is not None and b["targeted_asr"] is not None else None
        )
        paired["safe_completion_change_pp"] = (
            (b["safe_completion_rate"] - a["safe_completion_rate"]) * 100.0
            if a["safe_completion_rate"] is not None and b["safe_completion_rate"] is not None else None
        )
        paired["task_utility_change_pp"] = (
            (b["task_utility_rate"] - a["task_utility_rate"]) * 100.0
            if a["task_utility_rate"] is not None and b["task_utility_rate"] is not None else None
        )
        paired["relative_asr_reduction"] = (
            (a["targeted_asr"] - b["targeted_asr"]) / a["targeted_asr"]
            if a["targeted_asr"] else None
        )

    has_no_attack_control = any(
        str(c.get("condition", "")).lower() in {"benign", "no_attack", "no-attack", "clean"}
        for c in cases
    )

    return {
        "metric_scope": {
            "has_no_attack_control": has_no_attack_control,
            "benign_utility_available": has_no_attack_control,
            "safe_completion_is_proxy": True,
            "note": (
                "Current A/B traces are attacked conditions. Task utility is not AgentDojo Benign Utility; "
                "safe completion = utility && !security is shown as a schema-level proxy."
                if not has_no_attack_control
                else "A no-attack control condition is present; adapters should still verify metric semantics."
            ),
        },
        "conditions": condition_summary,
        "paired_defense": paired,
        "defense_failure_modes": _defense_failure_modes(cases, defense),
        # Keep the all-condition view for backwards compatibility, but the dashboard
        # uses condition-specific hotspots so baseline/defense samples are never mixed.
        "exposure_hotspots": _exposure_hotspots(cases),
        "exposure_hotspots_by_condition": {
            cond: _exposure_hotspots(group) for cond, group in sorted(by_condition.items())
        },
    }
