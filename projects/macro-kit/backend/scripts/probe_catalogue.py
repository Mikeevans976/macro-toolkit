"""
Check every Bloomberg ticker in a series catalogue against the Terminal:
does it exist, how much history does it have, when was its last observation.

    cd backend && python scripts/probe_catalogue.py data/series_catalogue_mx.json
    cd backend && python scripts/probe_catalogue.py --tickers "CPMINDX Index" "CNCPIYOY Index"

Prints one line per series: OK / STALE (no observation in the last 120 days)
/ SHORT (< 24 observations in the window) / DEAD (no data or unknown ticker).
Exits non-zero if any DFM input or yield series is DEAD.
"""
import argparse
import json
import sys
import warnings
from datetime import date, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
warnings.filterwarnings("ignore")

import bbg  # noqa: E402

YEARS = 6
STALE_DAYS = 120
MIN_OBS = {"quarterly": 8}          # observations in the window; default 24 (two years of monthly)


def probe(tickers: list[str], freq: dict[str, str] | None = None) -> dict[str, dict]:
    end = date.today()
    start = end - timedelta(days=365 * YEARS)
    ref = bbg.bdp(tickers, ["NAME"])
    hist = bbg.bdh(tickers=tickers, flds=["PX_LAST"], start_date=start.isoformat(), end_date=end.isoformat())
    out = {}
    for t in tickers:
        s = hist[(t, "PX_LAST")].dropna() if (t, "PX_LAST") in hist.columns else None
        name = ref.get(t, {}).get("NAME")
        if s is None or s.empty:
            status, n, last, value = "DEAD", 0, None, None
        else:
            n, last, value = len(s), s.index[-1].date(), float(s.iloc[-1])
            status = ("STALE" if (end - last).days > STALE_DAYS
                      else "SHORT" if n < MIN_OBS.get((freq or {}).get(t), 24) else "OK")
        out[t] = {"name": name, "status": status, "n": n, "last": last, "value": value}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("catalogue", nargs="?")
    ap.add_argument("--tickers", nargs="*")
    args = ap.parse_args()

    freq: dict[str, str] = {}
    if args.tickers:
        rows = [(t, t, False) for t in args.tickers]
    else:
        cat = json.loads((BACKEND / args.catalogue).read_text(encoding="utf-8"))
        entries = [e for e in cat["series"] if e.get("ticker_bloomberg")]
        rows = [(e["id"], e["ticker_bloomberg"], e.get("dfm_col_index") is not None or e.get("role") == "market_data")
                for e in entries]
        freq = {e["ticker_bloomberg"]: e.get("frequency") for e in entries}

    res = probe(sorted({t for _, t, _ in rows}), freq)
    dead_required = []
    for sid, t, required in rows:
        r = res[t]
        if r["status"] == "DEAD" and required:
            dead_required.append(sid)
        val = "" if r["value"] is None else f"{r['value']:.3f}"
        print(f"{r['status']:5s} {sid:34s} {t:24s} n={r['n']:<5d} last={r['last']}  {val:>10s}  {r['name'] or '?'}")
    if dead_required:
        print(f"\nDEAD required series: {dead_required}")
        sys.exit(1)


if __name__ == "__main__":
    main()
