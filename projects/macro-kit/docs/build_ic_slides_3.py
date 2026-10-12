"""Build the 2 macro-kit IC slides on top of the 'French and Italian spreads briefing' template."""
import sys
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import MSO_ANCHOR
from pptx.oxml.ns import qn

SRC, OUT = sys.argv[1], sys.argv[2]

# Template palette
BG, CARD, BORDER = "F5F2EC", "FBF9F5", "DDD6CA"
NAVY, BLUE, RED = "17202B", "2B5C8A", "A8322B"
GREY, MUTED, ONDARK, ONDARK_MUTED = "5F6670", "6B7078", "F5F2EC", "B9BEC6"
SERIF, SANS = "Source Serif 4", "Inter"

prs = Presentation(SRC)

# Drop every template slide; keep master, layout and theme
sldIdLst = prs.slides._sldIdLst
for sldId in list(sldIdLst):
    prs.part.drop_rel(sldId.rId)
    sldIdLst.remove(sldId)

layout = prs.slide_layouts[0]


def rgb(h):
    return RGBColor.from_string(h)


def new_slide():
    s = prs.slides.add_slide(layout)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = rgb(BG)
    return s


def box(s, x, y, w, h, fill=CARD, line=BORDER, radius=0.04):
    shp = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
    shp.adjustments[0] = radius
    shp.fill.solid()
    shp.fill.fore_color.rgb = rgb(fill)
    if line:
        shp.line.color.rgb = rgb(line)
        shp.line.width = Pt(0.5)
    else:
        shp.line.fill.background()
    shp.shadow.inherit = False
    return shp


def rule(s, x, y, w, color=BORDER):
    ln = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x), Inches(y), Inches(x + w), Inches(y))
    ln.line.color.rgb = rgb(color)
    ln.line.width = Pt(0.5)
    return ln


def text(s, x, y, w, h, paras, anchor=MSO_ANCHOR.TOP):
    """paras: list of paragraphs; each paragraph is a list of runs (str, opts) or a single (str, opts)."""
    tb = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    for i, para in enumerate(paras):
        if isinstance(para, tuple):
            para = [para]
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        first = para[0][1]
        p.line_spacing = Pt(first.get("lh", first.get("sz", 12) * 1.4))
        if i > 0:
            p.space_before = Pt(first.get("before", 0))
        for t, o in para:
            r = p.add_run()
            r.text = t
            f = r.font
            f.size = Pt(o.get("sz", 12))
            f.bold = o.get("b", False)
            f.italic = o.get("i", False)
            f.name = o.get("font", SANS)
            f.color.rgb = rgb(o.get("c", NAVY))
            if o.get("spc"):
                r._r.get_or_add_rPr().set("spc", str(o["spc"]))
    return tb


def _border(tcPr, tag, color="C4C4C2"):
    from pptx.oxml.xmlchemy import OxmlElement
    ln = OxmlElement(tag)
    ln.set("w", "12700")
    sf = OxmlElement("a:solidFill")
    c = OxmlElement("a:srgbClr")
    c.set("val", color)
    sf.append(c)
    ln.append(sf)
    return ln


def table(s, x, y, col_w, data, row_h):
    """Table styled like the template: grey header, hairline borders, no banding."""
    gf = s.shapes.add_table(len(data), len(col_w), Inches(x), Inches(y), Inches(sum(col_w)), Inches(sum(row_h)))
    tbl = gf.table
    tblPr = tbl._tbl.tblPr
    for attr in ("firstRow", "bandRow"):
        tblPr.set(attr, "0")
    for el in tblPr.findall(qn("a:tableStyleId")):
        tblPr.remove(el)
    for j, w in enumerate(col_w):
        tbl.columns[j].width = Inches(w)
    for i, rh in enumerate(row_h):
        tbl.rows[i].height = Inches(rh)
    for i, row in enumerate(data):
        for j, val in enumerate(row):
            cell = tbl.cell(i, j)
            cell.margin_left = cell.margin_right = Inches(0.1)
            cell.margin_top = cell.margin_bottom = Inches(0.06)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.line_spacing = Pt(14.5)
            r = p.add_run()
            r.text = val
            r.font.size = Pt(11)
            r.font.name = SANS
            r.font.bold = i == 0 or j == 0
            r.font.color.rgb = rgb(NAVY if (i == 0 or j in (0, len(row) - 1)) else GREY)
            tcPr = cell._tc.get_or_add_tcPr()
            for tag in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
                tcPr.append(_border(tcPr, tag))
            if i == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = rgb("E3E1DD")
            else:
                cell.fill.background()
    return gf


def title(s, t):
    text(s, 0.89, 0.89, 11.9, 0.55, [(t, dict(sz=30, font=SERIF, lh=36))])


def kicker(s, y, t, c=BLUE):
    text(s, 0.89, y, 11.9, 0.28, [(t.upper(), dict(sz=12, b=True, c=c, spc=100, lh=16.8))])


def footer(s, t):
    text(s, 0.89, 6.97, 11.9, 0.3, [(t, dict(sz=11, c=MUTED, lh=15))])


# ---------------------------------------------------------------- Slide 1
s1 = new_slide()
title(s1, "Our framework: from macro themes to a robust portfolio")
kicker(s1, 1.66, "The process · five steps, applied to every theme")

steps = [
    ("01 · Themes", "Identify themes",
     "12–15 overarching macro themes that drive returns across asset classes"),
    ("02 · Probabilities", "Assign odds",
     "Outcome distribution per theme vs market pricing gives a probability-weighted expected PnL"),
    ("03 · Trades", "Pick the trade",
     "Best payout for the upfront premium; trades ranked by payout/cost ratio, carry and RV"),
    ("04 · Correlations", "Map co-movement",
     "Expected correlations and payoffs across themes: where risk diversifies"),
    ("05 · Allocation", "Allocate capital",
     "Size by probability-weighted payoff and risk contribution; estimate the PnL of the whole book"),
]
n, x0, W, gap, y, h = 5, 0.89, 11.9, 0.2, 2.01, 1.95
cw = (W - gap * (n - 1)) / n
for i, (lab, head, body) in enumerate(steps):
    x = x0 + i * (cw + gap)
    box(s1, x, y, cw, h)
    text(s1, x + 0.17, y + 0.17, cw - 0.34, h - 0.3, [
        (lab.upper(), dict(sz=11, b=True, c=BLUE, spc=100, lh=15)),
        (head, dict(sz=15, b=True, lh=19, before=6)),
        (body, dict(sz=12, c=GREY, lh=16, before=6)),
    ])

# Starting themes: expected direction by asset class and a suitable expression
kicker(s1, 4.18, "Starting themes · 4 of a targeted 12–15 · expected direction by asset class", c=RED)
header = ["Theme", "Rates", "FX", "Equities", "Commodities", "Suitable expression"]
rows = [
    ["Dollar debasement", "US curve steeper, term premium ↑", "USD ↓ vs EUR, JPY, CHF", "Non-US over US",
     "Gold ↑", "Long gold; USD puts vs EUR, JPY"],
    ["AI boom", "US real yields ↑", "USD ↑; KRW, TWD ↑", "Semis, tech ↑",
     "Copper, power ↑", "Long semis vs index; long copper"],
    ["Europe: growth and fiscal", "Bunds cheapen vs swaps, curve steeper", "EUR ↑", "Defence, banks ↑",
     "–", "EUR 10s30s steepener; long EUR/USD"],
    ["UK: BoE hikes gradually", "SONIA front end ↑, gilt curve flatter", "GBP ↑", "FTSE 250 ↓",
     "–", "Gilt 2s10s flattener; GBP/USD calls"],
]
col_w = [2.1, 2.7, 1.95, 1.4, 1.3, 2.45]
table(s1, x0, 4.5, col_w, [header] + rows, row_h=[0.3] + [0.42] * 4)

footer(s1, "Illustrative: expected directions and expressions are examples for discussion, not positions or recommendations.")
s1.notes_slide.notes_text_frame.text = (
    "The aim is to complement the current strategy with a more systematic portfolio construction process. "
    "We start from a small set of overarching macro themes, 12 to 15, and assign each one a probability distribution of outcomes. "
    "Comparing that distribution with market pricing gives a probability-weighted expected PnL for the theme. "
    "For each theme we pick the trade with the best payout for its upfront premium, and rank all candidate trades by payout/cost ratio, "
    "carry and relative value. We then measure how trades co-move across themes before allocating capital and estimating the PnL of "
    "the whole book. The table shows the four starting themes, how we expect each asset class to respond, and an example expression. "
    "These are illustrations for discussion, not positions."
)

# ---------------------------------------------------------------- Slide 2: toolkit in full
s2 = new_slide()
title(s2, "The toolkit: every tool answers a question in the framework")

cols = [
    ("01 · Themes", "Macro regime", "Where are growth and inflation surprising, and do rates reflect it?", [
        ("Macro heatmaps",
         "Mixed-frequency dynamic factor models (Kalman filter) nowcast growth and inflation in 10 economies; yield PCs regressed on the factors"),
        ("Global yields factor model",
         "PCA on 10y yields across DM and EM (global, DM, EM factors); residuals give rich/cheap z-scores"),
    ]),
    ("02 · Probabilities", "Implied odds", "What does the market already price?", [
        ("Option-implied scenarios",
         "Gram-Charlier densities from swaption forwards and normal vols; options monitor tracks vol, skew and premium"),
        ("Fair value modelling",
         "Rolling elastic-net models of rates, inflation and spreads on macro and market drivers"),
        ("Inflation fixings",
         "HICP, RPI and US CPI index paths rebuilt from fixing swaps"),
    ]),
    ("03 · Trades", "Relative value", "Which instrument expresses the view most cheaply?", [
        ("Swap and EGB RV", "Curves, flies and spreads by z-score, carry and roll; OIS and repo-bloc carry"),
        ("Fitted bond curves", "Spline-fitted curve with issue size, age and deliverability terms"),
        ("PCA (rates, inflation)", "Level/slope/curvature-hedged flies on nominal and linker curves"),
        ("Mean reversion (OU)", "Half-life, forward distributions, Sharpe by horizon, hit odds"),
    ]),
    ("03 · Trades", "Positioning and timing", "Is the trade crowded, and when do we enter?", [
        ("Rates positioning",
         "Daily price and open-interest signal, DV01-weighted and anchored to weekly COT via a Kalman filter; Euribor now, bond futures next"),
        ("Momentum", "Vol-scaled CTA signals over 1–12m lookbacks"),
        ("Print analysis", "Surprises vs the consensus range, and market reaction"),
        ("Seasonality backtester", "Calendar patterns backtested with PnL metrics"),
    ]),
    ("04–05 · Portfolio", "Correlation and risk", "Does the book diversify the way we think it does?", [
        ("Correlation regimes",
         "Flags pairs whose 1m correlation breaks from the prior 6m regime, on daily changes"),
        ("Trade blotter and watch", "The live book, entry levels and alerts"),
        ("In build", "Supply and funding monitors"),
    ]),
]
y, h = 1.66, 5.15
for i, (lab, head, q, items) in enumerate(cols):
    x = x0 + i * (cw + gap)
    box(s2, x, y, cw, h)
    text(s2, x + 0.17, y + 0.17, cw - 0.34, 1.35, [
        (lab.upper(), dict(sz=11, b=True, c=BLUE, spc=100, lh=15)),
        (head, dict(sz=15, b=True, lh=19, before=6)),
        (q, dict(sz=12, i=True, lh=16, before=6)),
    ])
    rule(s2, x + 0.17, y + 1.62, cw - 0.34)
    paras = []
    for j, (name, why) in enumerate(items):
        paras.append((name, dict(sz=12, b=True, c=MUTED if name == "In build" else NAVY, lh=15.5, before=0 if j == 0 else 8)))
        paras.append((why, dict(sz=10.5, c=GREY, lh=13.5, before=1)))
    text(s2, x + 0.17, y + 1.74, cw - 0.34, h - 1.85, paras)

footer(s2, "All tools built in-house. Each column feeds the agents on the next slide.")
s2.notes_slide.notes_text_frame.text = (
    "Each column answers one question in the framework. Macro regime: dynamic factor models nowcast growth and inflation and tell us "
    "whether rates reflect them, which is where themes come from. Implied odds: option-implied densities and fair value models tell us "
    "what the market already prices, so we only pay for views that differ from it. Fair value modelling generalises the inflation-swap "
    "elastic-net models we already run to rates and spreads. Rates positioning covers Euribor futures today and will extend to bond futures. "
    "Relative value and positioning pick the cheapest, best-timed instrument for each view. Correlation regimes and the trade blotter "
    "check that the book diversifies the way we think it does. Supply and funding monitors are in build."
)

# ---------------------------------------------------------------- Slide 3: AI roadmap
s3 = new_slide()
title(s3, "AI roadmap: why, how, and the agents that run the framework")
kicker(s3, 1.66, "Why and how we use AI")

goals = [
    ("Coverage", "More markets and asset classes, with the same team",
     "Agents run the full toolkit across every market daily and flag what has changed"),
    ("Speed", "Routine monitoring, screening and briefing streamlined",
     "Automated data checks, screens and first-draft briefings every morning"),
    ("Depth", "Broader, more consistent and documented analysis",
     "Agents read research, write and run models, and record their reasoning"),
]
gw, yg, hg = 2.75, 2.01, 1.72
for i, (head, why, how) in enumerate(goals):
    x = x0 + i * (gw + gap)
    box(s3, x, yg, gw, hg)
    text(s3, x + 0.2, yg + 0.17, gw - 0.4, hg - 0.3, [
        (head, dict(sz=15, b=True, lh=19)),
        (why, dict(sz=12, lh=16, before=4)),
        [("HOW  ", dict(sz=10.5, b=True, c=BLUE, spc=100, lh=14.5, before=6)), (how, dict(sz=11, c=GREY))],
    ])
dx = x0 + 3 * (gw + gap)
dw = W - (dx - x0)
box(s3, dx, yg, dw, hg, fill=NAVY, line=None)
text(s3, dx + 0.25, yg + 0.2, dw - 0.5, hg - 0.4, [
    ("The PM keeps every investment decision.", dict(sz=14, c=ONDARK, lh=19)),
    ("Agents propose, explain and document; every run is logged and auditable.",
     dict(sz=12, c=ONDARK_MUTED, lh=16, before=6)),
])

kicker(s3, 3.98, "The agents · live, next and planned", c=RED)
agents = [
    ("Live", "Fixed Income Pod",
     "Macro, RV, inflation and positioning specialists run their tools; a lead agent forms one view",
     "The toolkit", "Briefings and trade ideas"),
    ("Next", "Portfolio Builder",
     "Runs the five steps: odds, best trades, correlations, sizing and expected PnL",
     "Toolkit, book, sell-side research", "Proposed portfolio"),
    ("Next", "Risk",
     "Greeks of the book to rates, curve, FX and volatility factors; proposes hedges",
     "Book, market data", "Exposures and hedges"),
    ("Planned", "Research",
     "Maps sell-side research and news to our themes; tracks consensus against our odds",
     "Research, news", "Theme digests"),
    ("Planned", "Trade monitor",
     "Tracks each trade's thesis, levels, stops and carry; alerts when a theme's odds shift",
     "Blotter, toolkit", "Alerts and reviews"),
]
ya, ha = 4.33, 2.47
for i, (stage, head, body, inp, out) in enumerate(agents):
    x = x0 + i * (cw + gap)
    box(s3, x, ya, cw, ha)
    text(s3, x + 0.17, ya + 0.17, cw - 0.34, 1.6, [
        (stage.upper(), dict(sz=11, b=True, c=BLUE if stage == "Live" else RED, spc=100, lh=15)),
        (head, dict(sz=15, b=True, lh=19, before=4)),
        (body, dict(sz=11, c=GREY, lh=14.5, before=4)),
    ])
    rule(s3, x + 0.17, ya + 1.66, cw - 0.34)
    text(s3, x + 0.17, ya + 1.76, cw - 0.34, 0.65, [
        [("In  ", dict(sz=10.5, b=True, c=BLUE, lh=13.5)), (inp, dict(sz=10.5))],
        [("Out  ", dict(sz=10.5, b=True, c=BLUE, lh=13.5, before=3)), (out, dict(sz=10.5))],
    ])

footer(s3, "Agents are decision support. Portfolio Builder and Risk are next; Research and Trade monitor are planned.")
s3.notes_slide.notes_text_frame.text = (
    "Why AI: to cover more markets and asset classes with the same team, to streamline routine work, and to deepen the analysis. "
    "How: agents run the full toolkit across every market daily and flag what has changed; data checks, screens and first-draft "
    "briefings are automated; and agents read research, write and run models, and record their reasoning. Every run is logged, and "
    "the PM keeps every decision. "
    "The agents: the Fixed Income Pod is live, with specialists for macro, relative value, inflation and positioning feeding a lead agent. "
    "Next, a Portfolio Builder agent will run the five-step framework end to end using the toolkit, the live book and sell-side research, "
    "and a Risk agent will compute the book's Greeks to specific risk factors and propose hedges. Planned after that: a Research agent "
    "that maps sell-side research and news onto our themes and tracks consensus against our probabilities, and a Trade monitor that "
    "tracks each trade's thesis, levels and stops and alerts us when a theme's odds shift."
)

prs.save(OUT)
print("saved", OUT)
