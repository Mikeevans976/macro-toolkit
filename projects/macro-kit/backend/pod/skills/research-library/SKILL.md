---
name: research-library
description: How the Research Librarian collects sell-side research, processes it, and answers questions from the library.
---

# Research library

## 1. Collecting (a sweep)

1. `research_sweep_inputs`: ingests the drop folder and the research inbox. No browsing needed.
2. For each portal in `portal_list` that is enabled:
   - `portal_open` the start page. If `login_required` is true, **stop for that portal**: raise a `warning` alert ("<portal> needs a login") and move on. Never try to log in.
   - Find the latest-research view: look for links or menus like "Latest", "Research", "Rates", "Macro", "FX", "Economics", "Strategy". Use `portal_click` for menus and tabs, `portal_open` for links. Prefer the portal's own filters for rates, FX, macro and the pod's regions.
   - Collect only notes **published since the portal's last sweep** (see `last_sweep` in `portal_list`; on a first sweep, the last 3 business days).
   - For each relevant note: `portal_fetch` with the title, bank, authors and published date from the listing. Prefer the PDF link when one exists.
   - Relevance: macro, rates, FX, inflation, central banks, commodities and credit as macro signals, and the pod's live trades. Skip single-stock and corporate research.
   - Stop when you reach notes you have already collected (`portal_fetch` reports duplicates), or after about 25 notes per portal.
3. Report what you collected per portal, and any portal that needs a login.

## 2. Processing new documents

For each document with status `new` (`research_list status=new`):
1. `research_document` to read it.
2. `research_update` with:
   - **summary**: 3–6 sentences: the main call, the reasoning, and what changed versus the bank's prior view if stated;
   - **tags**: markets, regions, themes (e.g. "ECB", "EUR rates", "curve", "inflation");
   - corrected bank, title, authors and published date (YYYY-MM-DD).
3. `record_research_calls` with every explicit forecast, trade recommendation and directional view:
   - **Use stable market names** so calls line up across banks: "ECB deposit rate", "Fed funds upper bound", "BoE Bank Rate", "UST 10y", "Bund 10y", "EUR 2s10s", "BTP-Bund 10y", "EURUSD", "USDJPY", "US core PCE YoY", "EA HICP YoY", "Brent". Check `research_calls` for names already in use before inventing one.
   - Forecasts need a target date ("end-2027", "Q2 2027" or a date) and a value with unit.
   - Trades need a direction and the instrument in the statement; include entry, target and stop in the statement if given.
   - Keep each statement to one sentence, close to the bank's words.

## 3. Answering questions

- Start with `research_calls` (`latest_only=true`) for "what does the street think" questions: give the range, the median and the outliers, by bank, with dates.
- Use `research_calls` without latest_only for "who changed their view" questions; compare successive calls from the same bank.
- Use `research_search` for themes and arguments, then `research_document` for the detail.
- Always cite bank, title and date. Quote sparingly (a phrase, not paragraphs); research is licensed content.
- Say how current the library is (`research_stats`), especially if a bank hasn't been swept recently.
