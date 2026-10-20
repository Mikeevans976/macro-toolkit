"""
Check every ticker of the Momentum universe on the Terminal: history length,
last print, whether the roll-adjusted generic (R:00_0_R) is served, and the
static fields used for contract sizing.

    cd backend && python scripts/probe_momentum.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd  # noqa: E402

import bbg  # noqa: E402
import momentum as m  # noqa: E402
import momentum_universe as mu  # noqa: E402


def main() -> None:
    start = (pd.Timestamp.today() - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
    tickers = m._universe_tickers()
    fut = [t for t in tickers if m.is_generic_future(t)]
    plain = m._bdh([t for t in tickers if t not in fut], start)
    raw = m._bdh(fut, start)
    adj = m._bdh([m.adjusted_ticker(t) for t in fut], start)
    static = bbg.bdp(fut, m._STATIC_FIELDS) if fut else {}

    dead = 0
    print(f"{'ticker':28} {'rows':>5} {'last':>11} {'adj rows':>8}  static")
    for t in tickers:
        s = plain.get(t) if t not in fut else raw.get(t)
        a = adj.get(m.adjusted_ticker(t)) if t in fut else None
        if s is None and a is None:
            dead += 1
        last = f"{s.iloc[-1]:.4g}" if s is not None else "-"
        st = static.get(t, {})
        st_txt = (f"val_pt={st.get('FUT_VAL_PT')} ccy={st.get('CRNCY')} adv={st.get('VOLUME_AVG_20D')}"
                  if t in fut else "")
        print(f"{t:28} {len(s) if s is not None else 0:>5} {last:>11} "
              f"{(len(a) if a is not None else 0) if t in fut else '':>8}  {st_txt}")
    print(f"\n{dead} of {len(tickers)} tickers returned nothing "
          f"(universe: {len(mu.UNIVERSE)} rows, {sum(x.cta for x in mu.UNIVERSE)} CTA markets)")


if __name__ == "__main__":
    main()
