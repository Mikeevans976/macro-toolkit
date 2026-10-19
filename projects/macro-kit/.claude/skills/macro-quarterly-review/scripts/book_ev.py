"""Scenario P&L, expected P&L and max loss for a quarterly-review book.

Usage: python book_ev.py book.json

Spec (all money in £k):
{
  "target_ev": 10000,                      # optional: scale every trade so the book EV hits this
  "themes": [
    {"id": 1, "name": "BoE", "probs": [0.5, 0.25, 0.2, 0.05],
     "trades": [
       # linear: P&L = size * move, capped at target, floored at stop; direction from target vs entry
       {"id": "T1", "type": "linear", "entry": 476, "target": 435, "stop": 506, "size": 18.75,
        "levels": [430, 498, 395, 465]},  # level in each scenario (same units as entry, e.g. bp)
       # option: premium paid, payout as a fraction (0..1) of max_payout in each scenario
       {"id": "T2", "type": "option", "premium": 375, "max_payout": 1125, "payout_frac": [0.6, 0, 1, 0.13]},
       # explicit: P&L per scenario given directly (e.g. straddles valued off-model); max_loss required
       {"id": "T3", "type": "explicit", "pnl": [-14, 7, 106, 187], "max_loss": 187.5}
     ]}
  ],
  "pairings": [[1, 2, 2, 0, "A with one-and-done"]]   # optional: theme a, scenario idx, theme b, scenario idx, label
}
"""
import json
import sys


def trade_pnl(t):
    kind = t.get("type", "linear")
    if kind == "linear":
        sign = 1 if t["target"] > t["entry"] else -1
        gain, loss = abs(t["target"] - t["entry"]), abs(t["stop"] - t["entry"])
        pnl = [max(-loss, min(gain, sign * (lv - t["entry"]))) * t["size"] for lv in t["levels"]]
        return pnl, loss * t["size"]
    if kind == "option":
        return [f * t["max_payout"] - t["premium"] for f in t["payout_frac"]], t["premium"]
    return list(t["pnl"]), t["max_loss"]


def main(path):
    spec = json.load(open(path, encoding="utf-8"))
    rows, total_ev = [], 0.0
    for th in spec["themes"]:
        assert abs(sum(th["probs"]) - 1) < 1e-6, f"theme {th['id']} probabilities don't sum to 1"
        for t in th["trades"]:
            pnl, ml = trade_pnl(t)
            ev = sum(p * x for p, x in zip(th["probs"], pnl))
            rows.append((th, t, pnl, ml, ev))
            total_ev += ev
    k = spec["target_ev"] / total_ev if spec.get("target_ev") else 1.0
    if k != 1.0:
        print(f"Scale factor {k:.4f} (book EV {total_ev:,.0f} -> {spec['target_ev']:,.0f})\n")

    themes = {}
    for th, t, pnl, ml, ev in rows:
        acc = themes.setdefault(th["id"], {"name": th["name"], "probs": th["probs"], "pnl": [0.0] * len(pnl), "ml": 0.0, "ev": 0.0, "rows": []})
        pnl_k = [x * k for x in pnl]
        acc["pnl"] = [a + b for a, b in zip(acc["pnl"], pnl_k)]
        acc["ml"] += ml * k; acc["ev"] += ev * k
        size = f"{t['size'] * k:,.1f}/unit" if "size" in t else ""
        acc["rows"].append((t["id"], pnl_k, ml * k, ev * k, size))

    for tid, acc in themes.items():
        hdr = " | ".join(f"{chr(65 + i) if len(acc['probs']) else i} ({p:.0%})" for i, p in enumerate(acc["probs"]))
        print(f"## Theme {tid}: {acc['name']}\n\n| Trade | {hdr} | Max loss | Exp. P&L | Size |")
        print("|" + "---|" * (len(acc["probs"]) + 4))
        for r in acc["rows"]:
            print(f"| {r[0]} | " + " | ".join(f"{x:+,.0f}" for x in r[1]) + f" | {r[2]:,.0f} | {r[3]:+,.0f} | {r[4]} |")
        print(f"| **Theme {tid}** | " + " | ".join(f"**{x:+,.0f}**" for x in acc["pnl"]) + f" | **{acc['ml']:,.0f}** | **{acc['ev']:+,.0f}** | |\n")

    print(f"Book: max loss {sum(a['ml'] for a in themes.values()):,.0f}, expected P&L {sum(a['ev'] for a in themes.values()):+,.0f}, trades {len(rows)}")
    for a, sa, b, sb, label in spec.get("pairings", []):
        print(f"Pairing {label}: {themes[a]['pnl'][sa] + themes[b]['pnl'][sb]:+,.0f}")


if __name__ == "__main__":
    main(sys.argv[1])
