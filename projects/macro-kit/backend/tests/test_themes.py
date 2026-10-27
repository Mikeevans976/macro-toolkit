"""Trade themes: the shipped file loads, and expected P&L and totals add up to the quarterly review's."""

import json

import pytest

from routers.themes import THEMES_PATH, build_themes


@pytest.fixture(scope="module")
def book():
    return build_themes(json.loads(THEMES_PATH.read_text(encoding="utf-8")))


def test_totals_match_review(book):
    t = book["totals"]
    assert (t["themes"], t["trades"]) == (7, 25)
    assert t["max_loss_k"] == pytest.approx(18_560, abs=20)      # £18.56m (trade max losses are rounded)
    assert t["expected_pnl_k"] == pytest.approx(10_000, abs=60)  # +£10.0m


@pytest.mark.parametrize("theme_id, expected_k, worst_k", [
    (1, 2330, -1423), (2, 1510, -3079), (3, 770, -2178), (4, 1100, -1275),
    (5, 2100, -1817), (6, 890, -1224), (7, 1300, -1676),
])
def test_theme_figures(book, theme_id, expected_k, worst_k):
    theme = next(t for t in book["themes"] if t["id"] == theme_id)
    assert theme["expected_pnl_k"] == pytest.approx(expected_k, abs=10)
    # The review rounds each trade row, so its theme rows can differ by £1k
    assert min(s["pnl_k"] for s in theme["scenarios"]) == pytest.approx(worst_k, abs=2)


def test_rejects_bad_probabilities(book):
    raw = json.loads(THEMES_PATH.read_text(encoding="utf-8"))
    raw["themes"][0]["scenarios"][0]["prob"] = 0.9
    with pytest.raises(ValueError, match="sum to"):
        build_themes(raw)
