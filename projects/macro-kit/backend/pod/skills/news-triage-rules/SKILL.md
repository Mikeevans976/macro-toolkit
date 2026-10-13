---
name: news-triage-rules
description: How the News Scanner filters and routes news.
---

# News triage rules

1. **Relevance:** keep only items that could move G10 rates, FX, inflation, spreads or the pod's live trades. Drop commentary that repeats known facts.
2. **Source quality:** primary sources (central banks, statistics offices, governments) and established newswires first. Mark unconfirmed reports as such.
3. **Score:** impact (1–3) × surprise (1–3). Report items scoring 4 or more.
4. **Route:** name the desk and agent id each item matters for (see `routing-map`).
5. **Alert:** raise a `warning` alert only for items scoring 9 or touching a live trade's thesis.

Output: a short table (time, headline, source, score, route) and two lines on the day's dominant narrative.
