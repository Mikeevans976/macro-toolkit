"""Swaps RV central-bank meeting markers: the calendars are well-formed and the payload carries them."""

from collections import Counter
from datetime import date

import pytest

from swaps_rv import _POLICY_MEETINGS, _policy_meetings, compute_rv

# Decision weekday per bank, and the known exceptions
WEEKDAY = {"EUR": ("ECB", 3, set()), "GBP": ("BoE", 3, set()), "USD": ("FOMC", 2, {"2024-11-07"})}


@pytest.mark.parametrize("ccy", ["EUR", "GBP", "USD"])
def test_calendar_is_eight_decisions_a_year_on_the_right_weekday(ccy):
    bank, dates = _POLICY_MEETINGS[ccy]
    want_bank, weekday, exceptions = WEEKDAY[ccy]
    assert bank == want_bank
    assert dates == sorted(set(dates))
    wrong = [d for d in dates if date.fromisoformat(d).weekday() != weekday and d not in exceptions]
    assert not wrong, f"{bank} decisions off their usual weekday: {wrong}"
    assert set(Counter(d[:4] for d in dates).values()) == {8}


def test_payload_lists_meetings_in_the_data_range():
    rv = compute_rv("EUR")
    pm = rv["policy_meetings"]
    assert pm["bank"] == "ECB"
    assert pm["dates"] and all(rv["min_date"] <= d <= rv["as_of"] for d in pm["dates"])
    assert pm["next"] is None or pm["next"] > rv["as_of"]


def test_window_and_next_meeting():
    # (the GBP/USD sample CSVs are empty, so check the helper rather than compute_rv)
    pm = _policy_meetings("EUR", "2026-01-01", "2026-10-16")
    assert pm["dates"][0] == "2026-02-05" and pm["dates"][-1] == "2026-09-10" and pm["next"] == "2026-10-29"
    assert _policy_meetings("USD", "2026-01-01", "2026-10-16")["next"] == "2026-10-28"
    assert _policy_meetings("GBP", "2026-01-01", "2026-10-16")["next"] == "2026-11-05"
    assert _policy_meetings("JPY", "2026-01-01", "2026-10-16") is None
