---
name: trade-review
description: Post-mortem format for closed or rejected trades.
---

# Trade review

For each closed trade, and rejected trades worth learning from:
- **Outcome:** P&L if known, and what happened to the risk factor.
- **Thesis versus reality:** which parts of the thesis were right, which wrong.
- **Process:** were the Red Team's objections borne out? Was sizing appropriate? Did monitoring catch the turn?
- **Luck versus skill:** would the same process be right next time?
- **Lesson:** one or two sentences, phrased as a rule the pod can reuse.

Record lessons with `trade_note` on the trade and in a report via `publish_report` (kind 'weekly-review') so `search_pod_memory` can find them.
