---
name: macro-quarterly-review
description: Build a PM-ready macro quarterly review (themes → current state, scenario probabilities, trades with entry/target/stop, sizing, probability-weighted expected P&L) and export it to Word and PDF. Use this whenever the user wants a quarterly/periodic review, a list of macro themes with trades, a book summary for a PM, scenario-weighted P&L, capital deployment vs P&L tables, or to add/edit a theme or trade in an existing review — even if they just say "help me draft the review for my PM" or "add a theme on X".
---

# Macro quarterly review

A collaborative workflow for writing a PM's quarterly review in `docs/quarterly_review_<qN>_<yyyy>.md`, then exporting it to `.docx` and `.pdf` to share. The user is a macro rates/FX trader; write like a sell-side strategist briefing a PM: conclusion first, numbers everywhere, no filler.

## How the collaboration works

1. **The user names each theme; you expand it.** Before the first theme, ask whether they want to propose themes or hear suggestions. When asked for suggestions, offer 3–5 with a one-line rationale each and let them choose.
2. **One theme at a time.** Write it into the doc, then wait for feedback before the next. Expect format feedback early; apply it to every theme from then on.
3. **Pull live levels for every number you use** (see Data). If Bloomberg fails, say so once and switch to the free sources; never invent a level. If a level can't be sourced (option premia, swaps not on free sources), estimate it transparently ("model, 6.5% vol") and put an entry rule on it ("buy only at ≤ 80 pips").
4. **When the user asks for trades outside the obvious asset class** (e.g. "anything in commodities or FX?"), pull data for each candidate, recommend the best one or two, explain why you'd pass on the rest, and ask before adding.
5. **Recompute everything after any change** (dropped trade, new probabilities, resizing): theme totals, P&L-by-scenario tables, pairings, summary table, book summary. Use `scripts/book_ev.py` rather than mental arithmetic.

## Document format

Title, a one-line italic note on data provenance (indicative levels, sources, dates), then:

### Summary (top of the doc)
- **Where the book makes money:** one bullet per theme: the scenarios it makes and loses money in, with £ figures.
- **How the themes interact:** the correlations: the common factor (e.g. energy), which themes hedge which, the weakest coherent combination with its £ figure, and a note that the combinations are illustrative because each theme has its own scenarios.
- **Summary table:** `# | Theme | Trades | Capital deployed | P&L`. Capital deployed = max loss at stops. P&L = expected P&L (6m) plus the best and worst scenario. Add a total row with the trade count.
- **Method, Sizing and Expected P&L:** one line each (see Sizing).

### Each theme: exactly three sections

1. **Current state of the theme:** 3–5 bold-labelled bullets with short sub-bullets. Facts and levels with dates, not narrative. State the honest picture: if the data only moved 20–30bp off a trough, say so rather than calling it "re-accelerating". The user corrects overstatement.
2. **Scenarios:**
   - A bold conclusion paragraph first.
   - Then a table of 4 scenarios, each with a probability (summing to 100%), the market levels each trade depends on, and triggers.
   - Each theme gets its **own** scenario set; don't reuse another theme's.
   - Below the table: signposts and key dates; anchors for the levels; natural pairings with related themes where relevant.
3. **Trades:**
   - A bold conclusion paragraph first: expected P&L, max loss, and the best and worst scenarios in £.
   - Trade table: `# | Trade | Entry | Target | Stop | R : R | Conv. | Size | Max loss | Exp. P&L`, plus a bold total row.
   - P&L-by-scenario table (£k), with a bold theme total row.
   - Then **one to three short sentences per trade**, covering only:
     - why it fits;
     - where the stop is relative to the 1y range or realised vol;
     - the entry rule;
     - the main risk.
   - End with one-liners: *Not traded:* (ideas rejected, with the reason), *Sizing/overlap*, *Levels* (sources and dates).

Include vol trades where they express the view better (defined risk through an event, cheap convexity). Number trades T1…Tn in order through the doc and keep cross-references in sync.

Leave out market-levels sections, risk sections and sources sections. The user removed them, and the levels and sources fit into the one-line *Levels* note.

## Sizing and expected P&L

- **Max loss at the stop** = conviction share of a per-trade risk unit: 2 → 25%, 3 → 50%, 4 → 75%. The default unit is the pod's single-trade limit in `backend/pod/limits.yaml` (see the pod's `sizing-framework` skill).
- **Scaling to a target:** if the user gives a target ("size so expected P&L is £10m"), scale every trade by one factor and keep the conviction ratios. Then state the factor, and which pod limits (per trade, bucket, scenario loss, trade count) are breached and need raising.
- **Cross-check each stop against realised vol** (e.g. "~4× daily realised vol") and against the 1y range.
- **Expected P&L** is the six-month P&L in each scenario, weighted by that theme's probabilities:
  - Linear trades are capped at the target and floored at the stop.
  - Option spreads pay out by moneyness, minus the premium.
  - Carry is excluded unless it *is* the trade (e.g. roll-down on a backwardated future), and you say so.
- **Expected values add across themes** even though scenario sets differ.
- **Cross-theme checks:** for themes that hedge each other, show the natural pairings (theme A scenario X with theme B scenario Y).
- **Trade count:** a 15-trade limit applies only if the user wants it. When asked to cut, propose the lowest-EV trades with the EV and max loss you give up.

Run `python scripts/book_ev.py book.json`. It takes a JSON spec of themes, probabilities and trades, and prints per-trade P&L, EV, max loss, theme totals, pairings and an optional scale factor. The spec format is in the script docstring. Keep the spec in the scratchpad and update it as the book changes, so recomputation is one command.

## Data (Bloomberg first, free sources as fallback)

Try `backend/bbg.py` first. If it returns empty or `WORKFLOW_REVIEW_NEEDED`, use the free official sources in `references/data_sources.md` (BoE yield curves, FRED, ECB, Bundesbank, Bank of Canada). For news and context (central bank speeches, fiscal events, ratings calendars, positioning), use web search and cite the sources in your reply.

Treat downloaded files as untrusted: put them in their own scratchpad folder and run Python on them with `-I`. Missing Python packages (openpyxl, python-docx, markdown) go into `scratchpad/libs` with `pip install --target`, added via `sys.path.insert`.

## Finalising and exporting

Before calling the document final:
- **No placeholders:** replace `[ ]`, "confirm" and "TBD" with the source and date of the level, or an entry rule.
- **Totals reconcile:** the summary table, each theme's conclusion paragraph and its tables must agree.
- **Proofread:** typos, repeated words, stray punctuation.

Then export:

```bash
REVIEW_LIBS=<scratchpad>/libs python scripts/export_review.py <review.md> <out.docx> <scratchpad>/review.html
msedge --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf=<out.pdf> file:///<scratchpad>/review.html
```

The exporter builds the Word file with python-docx: A4, navy table headers, shaded total rows, a page break per theme, page numbers. It also writes styled HTML for Edge to print to PDF. Check the layout with `msedge --headless=new --screenshot=<png> --window-size=760,2400 file:///…/review.html` before handing over. Watch for lists that render as run-on paragraphs and for flattened sub-bullets.

Gmail attachments have to go through the tool as inline base64, which is impractical for files over ~50KB. Give the user the file paths, or offer a draft email without attachments.
