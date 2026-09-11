from pipeline.security_analysis import (
    build_security_analysis,
    exact_mcnemar_pvalue,
    wilson_interval,
)


def _case(pair, cond, utility, security, exposure=1, deviation=None, hijack=None):
    hijacks = [] if hijack is None else [hijack]
    return {
        "case_id": f"s__{pair}__{cond}",
        "pair_key": f"s__{pair}",
        "condition": cond,
        "utility": utility,
        "security": security,
        "injection_exposure": exposure,
        "first_deviation": deviation,
        "hijack_events": hijacks,
        "exposure_channel": "read_mail" if exposure is not None else None,
        "events": [
            {"index": 0, "role": "user", "function": None, "matched_to_gt": True},
            {"index": 1, "role": "tool_resp", "function": "read_mail", "matched_to_gt": True},
            {"index": 2, "role": "tool_call", "function": "send_mail", "matched_to_gt": False},
        ],
    }


def test_wilson_interval_bounds_and_centering():
    lo, hi = wilson_interval(5, 10)
    assert 0 <= lo < 0.5 < hi <= 1
    assert wilson_interval(0, 0) is None


def test_exact_mcnemar_known_values():
    assert exact_mcnemar_pvalue(0, 0) == 1.0
    # All 5 discordant pairs move in one direction: 2 * (1/2^5) = 0.0625
    assert exact_mcnemar_pvalue(5, 0) == 0.0625
    assert exact_mcnemar_pvalue(0, 5) == 0.0625


def test_security_analysis_pair_transitions_and_case_annotation():
    cases = [
        _case("p0", "A", True, True, deviation=2, hijack=2),
        _case("p0", "B", True, False, deviation=None, hijack=None),  # blocked
        _case("p1", "A", True, False, deviation=None, hijack=None),
        _case("p1", "B", True, True, deviation=2, hijack=2),        # regressed
        _case("p2", "A", True, True, deviation=2, hijack=2),
        _case("p2", "B", False, True, deviation=2, hijack=2),       # still hijacked, utility lost
        _case("p3", "A", True, False, deviation=None, hijack=None),
        _case("p3", "B", True, False, deviation=None, hijack=None),  # still safe
    ]
    result = build_security_analysis(cases)
    pair = result["paired_defense"]
    assert pair["n_pairs"] == 4
    assert pair["security_transitions"] == {
        "blocked": 1,
        "regressed": 1,
        "still_hijacked": 1,
        "still_safe": 1,
    }
    assert pair["utility_transitions"]["utility_lost"] == 1
    assert pair["mcnemar_exact_pvalue"] == 1.0
    assert result["conditions"]["A"]["targeted_asr"] == 0.5
    assert result["conditions"]["B"]["targeted_asr"] == 0.5
    assert result["metric_scope"]["benign_utility_available"] is False
    assert result["defense_failure_modes"]["compromised_cases"] == 2
    assert cases[0]["security_transition"] == "blocked"
    assert cases[0]["exposure_to_deviation"] == 1
    assert cases[0]["exposure_to_hijack"] == 1
    assert cases[0]["post_exposure_residual_tool_calls"] == 1
