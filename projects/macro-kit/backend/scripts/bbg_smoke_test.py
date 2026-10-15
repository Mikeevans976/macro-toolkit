"""
Check the live Bloomberg connection through bbg.py: session, BDP, BDH, BDS.

Run it in the same Windows environment as a logged-in Bloomberg Terminal
(the Desktop API only accepts local connections):

    cd backend && python scripts/bbg_smoke_test.py

Exits non-zero at the first step that fails.
"""
import sys
from datetime import date, timedelta
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

import bbg  # noqa: E402

TICKERS = ["ER1 Comdty", "USGG10YR Index", "GDBR10 Index"]


def step(name, fn):
    print(f"-- {name}")
    try:
        out = fn()
    except Exception as exc:
        print(f"   FAILED: {type(exc).__name__}: {exc}")
        sys.exit(1)
    print(f"   ok\n{out}\n")


def session():
    s = bbg.open_session()
    s.stop()
    return f"   connected to {bbg._HOST}:{bbg._PORT}"


def reference():
    return bbg.bdp(TICKERS, ["NAME", "PX_LAST", "LAST_UPDATE_DT"])


def history():
    end = date.today()
    df = bbg.bdh(TICKERS, ["PX_LAST"], (end - timedelta(days=14)).isoformat(), end.isoformat())
    if df.empty:
        raise RuntimeError("BDH returned no rows")
    return df.tail()


def bulk():
    rows = bbg.bds("ER1 Comdty", "FUT_CHAIN")
    if not rows:
        raise RuntimeError("BDS returned no rows")
    return f"   {len(rows)} contracts, first: {rows[0]}"


if __name__ == "__main__":
    step("session", session)
    step("BDP reference data", reference)
    step("BDH history (14 days)", history)
    step("BDS bulk data (ER futures chain)", bulk)
    print("Bloomberg connection works.")
