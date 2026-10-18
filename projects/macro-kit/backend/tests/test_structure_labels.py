"""Swaps RV structure labels say what the structure computes.

Label conventions (see curves_flies_config.py):
  forward curve  "B-A"      = B − A          e.g. "10y10y-5y10y" = 10y10y − 5y10y
  spot curve     "XsYs"     = Yy − Xy        e.g. "2s10s"        = 10y − 2y
  forward fly    "a|b|c"    = 2b − a − c     e.g. "1y1y|2y1y|3y1y"
  spot fly       "XsYsZs"   = 2Yy − Xy − Zy  e.g. "2s5s10s"
Curves are always longer minus shorter (positive = steep), and fly legs run short to long.
"""

import re

import pytest

import curves_flies_config as cfg
from swaps_rv import _parse_label, _structures, _valid_leg

LEG = re.compile(r"^\d+y(\d+y)?$")
SPOT_CURVE = re.compile(r"^(\d+)s(\d+)s$")
SPOT_FLY = re.compile(r"^(\d+)s(\d+)s(\d+)s$")

SOURCE_LISTS = {
    "CURVES": cfg.CURVES, "GBP_CURVES": cfg.GBP_CURVES, "USD_CURVES": cfg.USD_CURVES,
    "CURATED_CURVES": cfg.CURATED_CURVES, "EXTENDED_CURVES": cfg.EXTENDED_CURVES,
    "FLIES": cfg.FLIES, "GBP_FLIES": cfg.GBP_FLIES, "USD_FLIES": cfg.USD_FLIES,
    "CURATED_FLIES": cfg.CURATED_FLIES, "EXTENDED_FLIES": cfg.EXTENDED_FLIES,
}
ALL_ENTRIES = [(name, entry) for name, lst in SOURCE_LISTS.items() for entry in lst]


def legs_named_by(label: str) -> tuple:
    """The legs a label names, in config order: (front, back) or (front, belly, back)."""
    if m := SPOT_CURVE.match(label):
        return f"{m[1]}y", f"{m[2]}y"
    if m := SPOT_FLY.match(label):
        return f"{m[1]}y", f"{m[2]}y", f"{m[3]}y"
    if "|" in label:
        return tuple(label.split("|"))
    back, front = label.split("-")
    return front, back


def end(leg: str) -> int:
    s, t = _parse_label(leg)
    return s + t


@pytest.mark.parametrize("source,entry", ALL_ENTRIES, ids=[f"{n}:{e[0]}" for n, e in ALL_ENTRIES])
def test_label_matches_legs(source, entry):
    label, *legs = entry
    assert legs_named_by(label) == tuple(legs), (
        f"{source}: label {label!r} names {legs_named_by(label)} but the legs are {tuple(legs)}"
    )


@pytest.mark.parametrize("source,entry", ALL_ENTRIES, ids=[f"{n}:{e[0]}" for n, e in ALL_ENTRIES])
def test_legs_run_short_to_long(source, entry):
    label, *legs = entry
    assert all(LEG.match(leg) for leg in legs), f"{source}: malformed leg in {label!r}"
    ends = [end(leg) for leg in legs]
    assert ends == sorted(ends) and len(set(legs)) == len(legs), (
        f"{source}: {label!r} legs {legs} should run short to long (end dates {ends})"
    )


def test_same_label_same_legs_everywhere():
    """_union keeps the first definition of a label, so a clash would silently drop one."""
    seen: dict[str, tuple] = {}
    for source, (label, *legs) in ALL_ENTRIES:
        assert seen.setdefault(label, tuple(legs)) == tuple(legs), (
            f"{source}: {label!r} defined with legs {legs}, elsewhere {seen[label]}"
        )


def test_no_structure_listed_twice_under_different_labels():
    by_legs: dict[tuple, str] = {}
    for _, (label, *legs) in ALL_ENTRIES:
        other = by_legs.setdefault(tuple(legs), label)
        assert other == label, f"{label!r} and {other!r} are the same structure"


def test_engine_drops_nothing():
    """_structures leaves out legs it cannot price or roll; every configured structure should survive."""
    configured = {e[0] for e in cfg.CORE_CURVES + cfg.CORE_FLIES + cfg.EXTENDED_CURVES + cfg.EXTENDED_FLIES}
    built = {x[0] for x in _structures("extended")}
    dropped = sorted(configured - built)
    assert not dropped, f"not priceable (leg beyond the curve or a 1y spot): {dropped}"
    for _, (label, *legs) in ALL_ENTRIES:
        assert all(_valid_leg(*_parse_label(leg)) for leg in legs), label


def test_engine_weights_follow_the_label():
    """What the engine computes: curves back − front, flies 2 × belly − wings."""
    for label, group, legs, weights, _ in _structures("extended"):
        assert legs == legs_named_by(label), label
        assert weights == ((-1, 1) if group == "curve" else (-1, 2, -1)), label


def test_core_contains_every_market_list():
    core = {e[0] for e in cfg.CORE_CURVES + cfg.CORE_FLIES}
    for name in ("CURVES", "GBP_CURVES", "USD_CURVES", "CURATED_CURVES",
                 "FLIES", "GBP_FLIES", "USD_FLIES", "CURATED_FLIES"):
        missing = {e[0] for e in SOURCE_LISTS[name]} - core
        assert not missing, f"{name} entries missing from the core: {sorted(missing)}"


def test_backwards_label_is_caught():
    """The check that would have flagged the old '10y2y-12y3y' entry."""
    assert legs_named_by("10y2y-12y3y") != ("10y2y", "12y3y")
    assert legs_named_by("12y3y-10y2y") == ("10y2y", "12y3y")
