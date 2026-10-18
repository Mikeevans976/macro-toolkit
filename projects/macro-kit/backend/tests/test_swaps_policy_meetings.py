"""Swaps RV central-bank meeting markers: the ECB list is well-formed and the payload carries it."""

from collections import Counter
from datetime import date

from swaps_rv import _POLICY_MEETINGS, _policy_meetings, compute_rv


def test_ecb_calendar_is_eight_thursdays_a_year():
    bank, dates = _POLICY_MEETINGS["EUR"]
    assert bank == "ECB"
    assert dates == sorted(set(dates))
    assert all(date.fromisoformat(d).weekday() == 3 for d in dates), "ECB decisions are on Thursdays"
    assert set(Counter(d[:4] for d in dates).values()) == {8}


def test_payload_lists_meetings_in_the_data_range():
    rv = compute_rv("EUR")
    pm = rv["policy_meetings"]
    assert pm["bank"] == "ECB"
    assert pm["dates"] and all(rv["min_date"] <= d <= rv["as_of"] for d in pm["dates"])
    assert pm["next"] is None or pm["next"] > rv["as_of"]


def test_no_meetings_listed_for_other_currencies():
    # (the GBP/USD sample CSVs are empty, so check the helper rather than compute_rv)
    assert _policy_meetings("USD", "2021-01-01", "2026-10-16") is None
    assert _policy_meetings("GBP", "2021-01-01", "2026-10-16") is None


def test_window_and_next_meeting():
    pm = _policy_meetings("EUR", "2026-01-01", "2026-10-16")
    assert pm["dates"][0] == "2026-02-05" and pm["dates"][-1] == "2026-09-10" and pm["next"] == "2026-10-29"
