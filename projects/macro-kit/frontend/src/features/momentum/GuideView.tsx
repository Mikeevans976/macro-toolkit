import type { ReactNode } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ACCENT, AMBER, FG2, FG3, FG4, GREEN, MUTED, NUM, RED, SPEED_COLORS, cardStyle, eyebrow } from './format'

// The worked example was computed with backend/momentum.py on a stylised S&P 500 series
// (tanh response, speed weights 10/35/40/15, leverage 0.60, AUM $300bn). Numbers are illustrative.

const SECTIONS: [string, string][] = [
  ['overview', 'Overview'],
  ['data', 'Data and universe'],
  ['signals', 'Signals'],
  ['position', 'Position'],
  ['regimes', 'Regimes'],
  ['projection', 'Flip, flat flow, scenarios'],
  ['sizing', 'Dollar sizing'],
  ['calibration', 'Calibration and P&L'],
  ['example', 'Worked example'],
  ['reading', 'Reading the monitor'],
  ['limits', 'Limitations'],
]

const p: React.CSSProperties = { fontSize: 13, color: FG2, lineHeight: 1.75, margin: '0 0 12px', maxWidth: 860 }
const h3: React.CSSProperties = { fontSize: 13, color: '#eef2f6', fontWeight: 500, margin: '18px 0 8px' }
const mono: React.CSSProperties = { fontFamily: NUM, color: '#e4eaf1' }
const th: React.CSSProperties = {
  textAlign: 'right', fontWeight: 500, color: MUTED, fontSize: 10.5, padding: '6px 10px',
  textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid rgba(200,220,240,0.09)', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  textAlign: 'right', padding: '5px 10px', fontFamily: NUM, fontSize: 12, color: FG2,
  borderBottom: '1px solid rgba(200,220,240,0.04)', whiteSpace: 'nowrap',
}
const tdText: React.CSSProperties = { ...td, textAlign: 'left', fontFamily: "'Geist', sans-serif", whiteSpace: 'normal' }

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`guide-${id}`} style={{ ...cardStyle, padding: '20px 24px', scrollMarginTop: 56 }}>
      <div style={eyebrow}>{title}</div>
      {children}
    </section>
  )
}

function Formula({ children }: { children: ReactNode }) {
  return (
    <pre style={{
      fontFamily: NUM, fontSize: 12.5, color: '#e4eaf1', background: 'rgba(200,220,240,0.04)',
      border: '1px solid rgba(200,220,240,0.07)', borderRadius: 6, padding: '10px 14px', margin: '0 0 14px',
      overflowX: 'auto', lineHeight: 1.7, maxWidth: 860,
    }}>{children}</pre>
  )
}

function Table({ head, rows, left = 1 }: { head: string[]; rows: ReactNode[][]; left?: number }) {
  return (
    <div style={{ overflowX: 'auto', margin: '0 0 14px' }}>
      <table style={{ borderCollapse: 'collapse', minWidth: '60%' }}>
        <thead>
          <tr>{head.map((h, i) => <th key={h} style={{ ...th, textAlign: i < left ? 'left' : 'right' }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} style={j < left ? tdText : td}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr', gap: 12, marginTop: 22 }}>
      <div style={{
        width: 24, height: 24, borderRadius: 12, border: `1px solid ${ACCENT}`, color: ACCENT, fontFamily: NUM,
        fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{n}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...h3, marginTop: 2 }}>{title}</div>
        {children}
      </div>
    </div>
  )
}

const pos = (v: string) => <span style={{ color: GREEN }}>{v}</span>
const neg = (v: string) => <span style={{ color: RED }}>{v}</span>
const sgn = (v: number, dp = 2) => (v >= 0 ? pos(`+${v.toFixed(dp)}`) : neg(`−${Math.abs(v).toFixed(dp)}`))

// Response functions, as in momentum.response()
const BAZ_PEAK = Math.SQRT2 * Math.exp(-0.5)
const RESPONSE_CURVE = Array.from({ length: 81 }, (_, i) => {
  const y = -4 + i * 0.1
  return {
    y: Number(y.toFixed(1)),
    tanh: Math.tanh(y / 1.5),
    baz: (y * Math.exp(-y * y / 4)) / BAZ_PEAK,
    linear: Math.max(-1, Math.min(1, y / 2)),
  }
})

// Worked example: model position (% of max), weekly, 13 weeks ago → now
const EX_PATH = [87.2, 93.6, 95.3, 95.7, 95.3, 92.7, 88.5, 82.8, 72.7, 52.2, 40.8, 31.6, 21.0, 5.8]
  .map((v, i, a) => ({ week: i - (a.length - 1), v }))

const EX_SPEEDS: [string, number, number, number, number, number, number, number][] = [
  // speed, fast EMA, slow EMA, difference, normaliser, y, tanh(y/1.5), weight
  ['8/24', 34.00, 35.96, -1.96, 1.418, -1.38, -0.726, 0.10],
  ['16/48', 35.12, 36.84, -1.73, 2.001, -0.86, -0.519, 0.35],
  ['32/96', 36.52, 34.47, 2.05, 2.829, 0.73, 0.449, 0.40],
  ['64/192', 36.39, 28.02, 8.37, 4.000, 2.09, 0.884, 0.15],
]

const EX_SCEN: [string, string, string, number, number][] = [
  // horizon, shock, price, position after, change
  ['1 week', '−2σ', '6,173.7', -16.2, -22.0],
  ['1 week', '−1σ', '6,299.0', -10.7, -16.5],
  ['1 week', '0 (flat)', '6,424.2', -4.3, -10.2],
  ['1 week', '+1σ', '6,549.5', 3.0, -2.8],
  ['1 week', '+2σ', '6,674.7', 11.3, 5.5],
  ['2 weeks', '−2σ', '6,070.0', -32.3, -38.1],
  ['2 weeks', '0 (flat)', '6,424.2', -8.8, -14.6],
  ['2 weeks', '+2σ', '6,778.5', 25.8, 20.0],
]

const chartTooltip = {
  contentStyle: { background: '#0b0f14', border: '1px solid rgba(200,220,240,0.1)', borderRadius: 6, fontSize: 12, fontFamily: NUM },
}

export default function GuideView() {
  const go = (id: string) => document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {SECTIONS.map(([id, label]) => (
          <button key={id} onClick={() => go(id)} style={{
            fontSize: 11.5, padding: '3px 9px', borderRadius: 4, cursor: 'pointer', background: 'transparent',
            color: id === 'example' ? '#c9cbf2' : FG3,
            border: `1px solid ${id === 'example' ? 'rgba(139,143,216,0.4)' : 'rgba(200,220,240,0.1)'}`,
          }}>{label}</button>
        ))}
      </div>

      <Section id="overview" title="Overview">
        <p style={p}>
          The CTA Monitor estimates what a typical trend-following fund (CTA) holds in about 70 markets, how strong the trend
          behind each position is, how close each position is to flipping, and how much the fund would trade next week if
          prices stay put or move. Everything comes from one model CTA, fitted to the SG Trend Index when that index is
          available. The Single Series tab runs the same model on any ticker or expression you type.
        </p>
        <p style={p}>
          The model trades four trend speeds on volatility-adjusted prices. It sizes every market to the same risk, scaled
          by a sector budget, and maps trend strength to a position between −100% and +100% of its maximum. From the
          model's current state, the monitor works out the price that flips each position and the flows implied by
          different price paths, then converts those flows into dollars and contracts for an assumed industry AUM.
        </p>
        <Table head={['Column', 'What it shows']} rows={[
          ['Last / 1w', 'Latest close; one-week change in % (prices) or bp (yields and spreads).'],
          ['Regime', 'Trend classification from the four speeds and the 3-month efficiency ratio (see Regimes).'],
          ['Speeds (σ)', 'Normalised trend strength per speed, fastest on the left. Green up, red down; the number appears from 1σ.'],
          ['CTA position', 'Model position, % of maximum (−100 full short … +100 full long).'],
          ['Δ1w', 'Change in that position over the last 5 trading days, in percentage points.'],
          ['6m', 'Weekly position over the last six months.'],
          ['Flip at', 'Tomorrow\'s close that would take the position through zero, and that move in daily σ. Amber within 1.5σ.'],
          ['Flat 1w flow', 'Position change over 5 days if the price does not move, in points and in $ notional.'],
          ['Notional', 'Dollar position for the assumed trend-following AUM (CTA markets only).'],
          ['Flow / ADV', 'The flat 1-week flow in contracts as % of 20-day average volume. Amber above 10%.'],
        ]} />
      </Section>

      <Section id="data" title="Data and universe">
        <p style={p}>
          The universe has two kinds of rows. <b style={{ color: '#eef2f6' }}>CTA markets</b> are the liquid futures trend
          followers trade; they make up the model portfolio and get dollar sizing. <b style={{ color: '#eef2f6' }}>Reference
          rows</b> (cash yields, curves and spreads, DXY) get the same signals and regime but no sizing: they help read
          the rates complex in yield terms.
        </p>
        <Table head={['Group', 'Markets', 'Sector risk budget']} left={2} rows={[
          ['Bond futures', 'TU, FV, TY, US, Schatz, Bobl, Bund, Buxl, OAT, BTP, Gilt, JGB, Australia 10y, Canada 10y', '25%'],
          ['STIR futures', 'SOFR, Euribor, SONIA (4th quarterly contract)', '10%'],
          ['FX futures', 'EUR, GBP, JPY, CHF, AUD, CAD, NZD, MXN (all vs USD)', '20%'],
          ['Equity index futures', 'S&P 500, Nasdaq 100, Russell 2000, Euro Stoxx 50, DAX, CAC, FTSE, Nikkei, TOPIX, Hang Seng, ASX 200', '25%'],
          ['Commodity futures', 'WTI, Brent, heating oil, natural gas, gold, silver, copper, corn, soybeans, wheat', '20%'],
          ['Yields (reference)', 'US 2/5/10/30y, Bund 2/5/10/30y (BVAL), OAT 10y, BTP 10y, Gilt 2/10/30y, JGB 10y', '—'],
          ['Curves & spreads (reference)', 'US 2s10s and 5s30s, Germany 2s10s and 10s30s, UK 2s10s, BTP–Bund and OAT–Bund 10y (bp)', '—'],
          ['DXY (reference)', 'Dollar index spot, listed with the FX futures', '—'],
        ]} />
        <p style={p}>
          Each sector's budget is split equally across its markets, so each of the 14 bond futures has a risk weight of
          25% / 14 ≈ 1.8% and each of the 11 equity futures 25% / 11 ≈ 2.3%.
        </p>
        <p style={p}>
          Futures use Bloomberg's <span style={mono}>ratio-adjusted</span> generic contract (for example{' '}
          <span style={mono}>TY1 R:00_0_R Comdty</span>), which removes the jump at each roll so it is not read as a
          price move. If the adjusted ticker is unavailable the unadjusted one is used. History starts in 2012 and is
          cached on disk, topped up each day, and held in memory for 15 minutes; <i>Refresh</i> forces a new fetch.
          Without a Bloomberg connection the page uses deterministic simulated data and says so in the toolbar.
        </p>
      </Section>

      <Section id="signals" title="Signals">
        <p style={p}>
          Every market goes through the same five steps. The goal is a measure of trend strength that is comparable
          across markets with very different volatilities, and across four horizons.
        </p>
        <div style={h3}>1. Returns</div>
        <Formula>{`prices (futures, FX, indices):  r_t = p_t / p_{t−1} − 1
levels (yields, spreads):        r_t = p_t − p_{t−1}`}</Formula>
        <p style={p}>
          Yields and spreads use the change, since a percentage change of a yield is meaningless (and undefined near zero).
        </p>
        <div style={h3}>2. Volatility-normalised returns</div>
        <Formula>{`σ_t  = √ EWMA(r²), half-life 20 days         daily volatility
n_t  = r_t / σ_{t−1},  capped at ±10           return in σ units, using yesterday's vol`}</Formula>
        <p style={p}>
          Dividing by yesterday's volatility makes a 1σ day in Schatz and a 1σ day in natural gas the same size. The cap
          stops one extreme day (a data error, or a 20σ event) from dominating every signal.
        </p>
        <div style={h3}>3. Volatility-adjusted price</div>
        <Formula>{`z_t = n_1 + n_2 + … + n_t`}</Formula>
        <p style={p}>
          z is the price path redrawn so every day has unit volatility. Its level is arbitrary; only its changes matter.
        </p>
        <div style={h3}>4. Four EMA crossovers</div>
        <Formula>{`EMA_t = (1 − α)·EMA_{t−1} + α·z_t,     α = 2 / (span + 1)
x_k   = EMA_fast,k(z) − EMA_slow,k(z)`}</Formula>
        <Table head={['Speed', 'Fast / slow span (days)', 'α fast', 'α slow', 'Normaliser SD', 'Roughly captures']} rows={[
          [<span style={{ color: SPEED_COLORS[0] }}>8/24</span>, '8 / 24', '0.222', '0.080', '1.418', '1 month'],
          [<span style={{ color: SPEED_COLORS[1] }}>16/48</span>, '16 / 48', '0.118', '0.041', '2.001', '2–3 months'],
          [<span style={{ color: SPEED_COLORS[2] }}>32/96</span>, '32 / 96', '0.061', '0.021', '2.829', '4–6 months'],
          [<span style={{ color: SPEED_COLORS[3] }}>64/192</span>, '64 / 192', '0.031', '0.010', '4.000', 'about 1 year'],
        ]} />
        <div style={h3}>5. Normalise to σ</div>
        <Formula>{`y_k = x_k / SD_k

SD_k² = b_s²/(1−b_s²) − 2·b_s·b_f/(1−b_s·b_f) + b_f²/(1−b_f²),    b = 1 − α`}</Formula>
        <p style={p}>
          SD_k is the standard deviation the crossover would have if the market were a pure random walk, in closed form.
          So y = ±1 is an ordinary one-standard-deviation trend, ±2 a strong one, and beyond ±2.5 an unusual one. Because
          every speed is scaled the same way, the four values in the <i>Speeds</i> column are directly comparable.
        </p>
      </Section>

      <Section id="position" title="Position">
        <p style={p}>
          Each speed's trend strength is mapped to a position between −1 and +1 by a response function φ, and the four
          are blended with the speed weights:
        </p>
        <Formula>{`position = Σ_k  w_k · φ(y_k)          shown as % of max, −100 … +100;  Σ w_k = 1`}</Formula>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20, alignItems: 'center' }}>
          <Table head={['Response', 'φ(y)', 'Behaviour']} left={1} rows={[
            ['tanh (default)', 'tanh(y / 1.5)', 'Linear for small trends, approaching a full position at 2–3σ.'],
            ['baz', 'y·e^(−y²/4) / 0.858', 'Peaks at y = 1.41, then cuts exposure as the trend gets stretched.'],
            ['linear', 'clip(y / 2, ±1)', 'Proportional, capped at 2σ.'],
          ].map(r => [r[0], <span style={mono}>{r[1]}</span>, <span style={{ fontFamily: "'Geist', sans-serif", whiteSpace: 'normal', display: 'block', textAlign: 'left', maxWidth: 260 }}>{r[2]}</span>])} />
          <div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={RESPONSE_CURVE} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(200,220,240,0.04)" />
                <XAxis dataKey="y" type="number" domain={[-4, 4]} ticks={[-4, -2, 0, 2, 4]} tick={{ fontSize: 10, fill: MUTED }}
                  tickFormatter={(v: number) => `${v}σ`} tickLine={false} axisLine={false} />
                <YAxis domain={[-1.05, 1.05]} ticks={[-1, 0, 1]} tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} width={28} />
                <ReferenceLine y={0} stroke="rgba(200,220,240,0.15)" />
                <ReferenceLine x={0} stroke="rgba(200,220,240,0.15)" />
                <Tooltip {...chartTooltip} formatter={(v: number) => v.toFixed(2)} labelFormatter={(v: number) => `y = ${v}σ`} />
                <Line dataKey="tanh" stroke={ACCENT} dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line dataKey="baz" stroke={AMBER} dot={false} strokeWidth={1.2} isAnimationActive={false} />
                <Line dataKey="linear" stroke={FG4} dot={false} strokeWidth={1.2} strokeDasharray="4 3" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 11, color: FG4, textAlign: 'center' }}>
              <span style={{ color: ACCENT }}>tanh</span> · <span style={{ color: AMBER }}>baz</span> · linear
            </div>
          </div>
        </div>
        <p style={p}>
          The calibration (below) picks the response and the speed weights. Without it the model uses tanh and equal
          weights.
        </p>
        <p style={p}>
          <b style={{ color: '#eef2f6' }}>Sign convention for yields and curves.</b> The position is always for the series
          as quoted, so a long in <span style={mono}>USGG10YR</span> means yields are trending up, which corresponds to
          CTAs being <i>short</i> TY. The futures rows carry the actual positions; the yield rows are there to read the
          same trend in rate terms. The Single Series tab has a bond-equivalent toggle that flips the sign.
        </p>
      </Section>

      <Section id="regimes" title="Regimes">
        <p style={p}>
          The regime summarises the shape of the trend in one label. It uses four inputs from the speeds and the price:
        </p>
        <Formula>{`fast = y(8/24)
slow = ( y(32/96) + y(64/192) ) / 2
avg  = mean of the four y
ER   = |p_t − p_{t−63}| / Σ |daily changes over 63 days|      efficiency ratio: 1 straight line, 0 pure chop`}</Formula>
        <p style={p}>The rules are tested in this order; the first that matches wins.</p>
        <Table head={['Regime', 'Rule', 'Meaning']} left={3} rows={[
          [<span style={{ color: AMBER }}>Reversal ↑/↓</span>, 'fast and slow have opposite signs, |fast| ≥ 1, |slow| ≥ 0.75',
            'A turn in progress: the short trend has broken against the long one. The arrow is the new (fast) direction.'],
          [<span style={{ color: GREEN }}>Strong momentum</span>, 'all four speeds agree and |avg| ≥ 1.5',
            'Every horizon is trending the same way. CTAs are close to fully positioned.'],
          [<span style={{ color: '#9dd6bd' }}>Momentum</span>, '|avg| ≥ 0.75 and at least three speeds agree',
            'A clear trend, not yet confirmed by every horizon.'],
          [<span style={{ color: FG3 }}>Fading</span>, '|slow| ≥ 0.75 and |fast| < 0.5',
            'The long trend is intact but the short-term move has stalled. Positions drift lower over time.'],
          [<span style={{ color: FG3 }}>Range</span>, 'ER < 0.2 and |avg| < 0.5',
            'No trend and choppy prices. CTAs are small and prone to whipsaw.'],
          [<span style={{ color: FG4 }}>Mixed</span>, 'anything else', 'The speeds disagree without a clean turn.'],
        ]} />
        <p style={p}>
          <b style={{ color: '#eef2f6' }}>Stretched</b> is added to any regime when |avg| &gt; 2: the trend is extended,
          positions are near full, and a turn would force large unwinding. The arrow on each chip is the direction of
          the series itself (for yields, ↑ means yields rising).
        </p>
      </Section>

      <Section id="projection" title="Flip, flat flow, scenarios">
        <p style={p}>
          Because the model is a deterministic recursion, it can be run forward exactly. Today's EMAs, z, price and
          volatility are the state; feeding hypothetical closes through the same update gives tomorrow's signals and
          position. Volatility is held at today's level in every projection.
        </p>
        <div style={h3}>Flip at</div>
        <p style={p}>
          The close tomorrow at which the composite position crosses zero. The model evaluates a grid of one-day moves
          from −10σ to +10σ and refines each sign change with a root finder; the move closest to zero is shown, as a
          price and in daily σ. <span style={{ color: AMBER }}>Amber</span> means within 1.5σ: one ordinary day flips the
          position. <span style={mono}>&gt;10σ</span> means no plausible single day does.
        </p>
        <p style={p}>
          One day moves the signals surprisingly little. A 1σ close changes z by 1, so a crossover moves by (α_fast − α_slow)
          and its signal by (α_fast − α_slow) / SD: about <span style={mono}>0.10σ</span> for 8/24, 0.04σ for 16/48,
          0.014σ for 32/96 and 0.005σ for 64/192. A position only flips in one day when it is already near zero, so for
          established trends the flip shows &gt;10σ, and the scenarios are the better guide.
        </p>
        <div style={h3}>Flat 1w flow</div>
        <p style={p}>
          The position change over five days if every close equals today's. z stops moving, but the EMAs keep catching up
          with it: the fast EMA catches up quickly and the slow one slowly, so the crossovers age. Fast speeds lose
          strength first; slow speeds can still be building. This is the trading CTAs do in a quiet market, without any
          new price information. The Single Series tab also shows how many flat days it takes for the position to flip.
        </p>
        <div style={h3}>Scenarios</div>
        <p style={p}>
          The price moves in a straight line to a total move of k σ over h days, with k ∈ {'{−2, −1, 0, +1, +2}'} and h = 5
          or 10 business days. The σ here is the volatility over the horizon, σ_daily × √h, so a 1σ week is a typical
          week. The sector card runs the 1-week version for every market in a sector at once and adds up the dollar
          flows; the Single Series tab shows the full grid for one market.
        </p>
      </Section>

      <Section id="sizing" title="Dollar sizing">
        <p style={p}>
          The model sizes positions like a risk-parity CTA: a full position in a market carries a fixed amount of annual
          dollar volatility, set by the AUM, the model's leverage and the market's risk weight.
        </p>
        <Formula>{`full risk_i  = AUM × B × w_i                       annual $ volatility of a 100% position
risk_i       = position_i × full risk_i
notional_i   = risk_i / σ_ann,i                     σ_ann = daily σ × √252
contracts_i  = notional_i / (price × point value × FX to USD)
flow / ADV   = |flat 1w flow in contracts| / 20-day average volume`}</Formula>
        <p style={p}>
          Calmer markets get more notional for the same risk: a full Schatz position is many times the notional of a
          full natural gas position. <span style={mono}>B</span> is the leverage from the calibration; uncalibrated, it
          is set so the model portfolio runs at 12% annual volatility. <span style={mono}>AUM</span> is the{' '}
          <i>Trend AUM $bn</i> input in the tab bar (default $300bn, roughly the trend-following industry); every dollar
          figure scales linearly with it, while signals, regimes and flips do not depend on it.
        </p>
        <p style={p}>
          Contract counts need Bloomberg static fields (<span style={mono}>FUT_VAL_PT</span>, <span style={mono}>CRNCY</span>,{' '}
          <span style={mono}>VOLUME_AVG_20D</span>, <span style={mono}>OPEN_INT</span>), so they are blank on simulated data.
          Reference rows (yields, curves) have no dollar sizing on the monitor; in the Single Series tab a yield is sized in
          DV01 instead of notional.
        </p>
      </Section>

      <Section id="calibration" title="Calibration and P&L">
        <p style={p}>
          The speed weights, the response function and the leverage come from fitting the model to the SG Trend Index
          (<span style={mono}>NEIXCTAT Index</span>), a daily index of the largest trend followers.
        </p>
        <Formula>{`1. For each speed k, build a portfolio that trades only that speed across all CTA markets,
   with the sector risk weights:     R_k,t = Σ_i  w_i · φ(y_k,i,t−1) · n_i,t / √252
2. Regress the index's weekly return on the four weekly R_k (last 156 weeks),
   with non-negative coefficients β_k.
3. Repeat for tanh, baz and linear; keep the response with the highest R².
4. Speed weights w_k = β_k / Σβ;   leverage B = Σβ.`}</Formula>
        <p style={p}>
          The card reports the in-sample R², the <b style={{ color: '#eef2f6' }}>out-of-sample R²</b> (fitted on the three
          years ending a year ago, scored on the last 52 weeks), the correlation and the annual tracking error against
          the index's own volatility. The out-of-sample R² is the honest measure of how far to trust the table: a typical
          replication of this kind explains roughly half to two-thirds of weekly index returns. If the best R² is below
          0.05, or the index is unavailable, the model falls back to tanh, equal weights and a 12% volatility target and
          says so.
        </p>
        <p style={p}>
          The P&L card shows the model's cumulative weekly return over five years (signal only, before costs, carry and
          roll yield) against the index, with the model's drawdown shaded. Trend followers in a deep or fast drawdown tend
          to cut risk across the board, which adds selling on top of the signal-driven flows in the table.
        </p>
        <p style={{ ...p, color: '#dfbb78' }}>
          On simulated data the "SG Trend Index" is itself simulated from a known blend of the speeds plus noise, so the
          calibration card is a self-test of the fitting code, not evidence about real CTAs.
        </p>
      </Section>

      <Section id="example" title="Worked example: S&P 500 after a sell-off">
        <p style={p}>
          This walks one market through every step, using numbers computed by the model itself on a stylised S&P 500
          future: a year-long rally followed by a three-week sell-off. The model settings are tanh response, speed
          weights 10 / 35 / 40 / 15%, leverage B = 0.60 and AUM $300bn. They are illustrative; the live monitor uses
          the current calibration.
        </p>

        <Step n={1} title="The market">
          <Table head={['', 'Value']} rows={[
            ['Close, Fri 16 Oct 2026', '6,424.2'],
            ['One week earlier', '6,562.6  (−2.1%)'],
            ['Peak, 10 Aug 2026', '7,175.8  (now −10.5% from the peak)'],
            ['One year earlier', '5,275.1  (+21.8% over the year)'],
            ['Daily volatility σ (EWMA, 20-day half-life)', '0.87%  (13.8% annualised)'],
          ]} />
          <p style={p}>
            The last day's return was −0.10%. Divided by the previous day's σ of 0.887%, that is n = −0.11σ: a quiet day,
            which adds −0.11 to z. After all the history, z stands at 32.61.
          </p>
        </Step>

        <Step n={2} title="The four signals">
          <Table head={['Speed', 'EMA fast (z)', 'EMA slow (z)', 'Difference x', '÷ SD', '= y (σ)']} rows={EX_SPEEDS.map(
            ([s, f, sl, d, sd, y], i) => [
              <span style={{ color: SPEED_COLORS[i] }}>{s}</span>, f.toFixed(2), sl.toFixed(2), sgn(d), sd.toFixed(3), sgn(y),
            ])} />
          <p style={p}>
            The sell-off has pushed z below both 8/24 EMAs and both 16/48 EMAs, so the two fast crossovers are negative.
            The slower EMAs still remember the rally: 32/96 is mildly positive and 64/192 strongly positive at +2.09σ.
            For comparison, a week ago the signals were −1.00 / −0.51 / +1.08 / +2.29, and four weeks ago −1.10 / +0.39 /
            +2.08 / +2.74. The turn has spread from the fastest speed to the second, and is eating into the third.
          </p>
        </Step>

        <Step n={3} title="From signals to a position">
          <Table head={['Speed', 'y', 'φ(y) = tanh(y/1.5)', 'Weight', 'Contribution']} rows={[
            ...EX_SPEEDS.map(([s, , , , , y, phi, w], i) => [
              <span style={{ color: SPEED_COLORS[i] }}>{s}</span>, sgn(y), sgn(phi, 3), `${(w * 100).toFixed(0)}%`, sgn(w * phi, 3),
            ]),
            [<b style={{ color: '#eef2f6' }}>Position</b>, '', '', '100%', <b>{pos('+0.058  =  +5.8%')}</b>],
          ]} />
          <p style={p}>
            The model is still marginally long: the slow speeds' longs (+0.180 and +0.133) just outweigh the fast speeds'
            shorts. Seven weeks ago, at the top, it was 95.7% long, and it has been cutting ever since:
          </p>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={EX_PATH} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="rgba(200,220,240,0.04)" vertical={false} />
              <XAxis dataKey="week" tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false}
                tickFormatter={(v: number) => (v === 0 ? 'now' : `${v}w`)} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: MUTED }} tickLine={false} axisLine={false} width={34}
                tickFormatter={(v: number) => `${v}%`} />
              <Tooltip {...chartTooltip} cursor={{ fill: 'rgba(200,220,240,0.04)' }}
                formatter={(v: number) => [`${v.toFixed(1)}%`, 'Position']}
                labelFormatter={(v: number) => (v === 0 ? 'This week' : `${-v} weeks ago`)} />
              <Bar dataKey="v" isAnimationActive={false}>
                {EX_PATH.map(d => <Cell key={d.week} fill={d.week === 0 ? ACCENT : GREEN} fillOpacity={d.week === 0 ? 0.9 : 0.55} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p style={p}>
            On the monitor this row would show a position bar at <span style={mono}>+6</span>, Δ1w{' '}
            <span style={mono}>{neg('−15')}</span> (from +21.0 a week ago) and a 6-month sparkline that rolls over from
            near +100.
          </p>
        </Step>

        <Step n={4} title="The regime">
          <Formula>{`fast = −1.38      slow = (0.73 + 2.09) / 2 = +1.41      avg = +0.14      ER = 0.09`}</Formula>
          <Table head={['Rule (in order)', 'Test', 'Result']} left={2} rows={[
            ['Reversal', 'signs differ ✓   |fast| = 1.38 ≥ 1 ✓   |slow| = 1.41 ≥ 0.75 ✓', <span style={{ color: AMBER }}>match</span>],
            ['Strong momentum, Momentum, Fading, Range', 'not tested: the first match wins', '—'],
          ]} />
          <p style={p}>
            The chip reads <span style={{ color: AMBER, ...mono }}>Reversal ↓</span>: the arrow follows the fast speed.
            Not stretched (|avg| = 0.14). Had the fast signal been −0.9 instead of −1.38, Reversal would fail, as would
            Strong momentum, Momentum (avg too small) and Fading (fast not flat). With ER = 0.09 and |avg| &lt; 0.5 the
            row would then have read <i>Range</i>: same market, a less decisive sell-off.
          </p>
        </Step>

        <Step n={5} title="Flip level">
          <p style={p}>
            Projecting one more close through the EMAs: a fall of 2.56 daily σ, to <span style={mono}>6,280.6</span>{' '}
            (−2.2%, −144 points), takes the signals to −1.67 / −1.02 / +0.62 / +2.04 and the position to exactly zero. The
            monitor shows <span style={mono}>Flip at 6,280.6 {neg('−2.6σ')}</span>, not amber because it is beyond 1.5σ.
            No single speed can be flipped within ±10σ in one day (the 8/24 signal moves only about 0.10σ per 1σ day),
            which is why per-speed flips in the Single Series tab show none.
          </p>
        </Step>

        <Step n={6} title="Flat 1-week flow">
          <p style={p}>
            If the S&P closes at 6,424.2 every day next week, the signals age to −1.28 / −1.05 / +0.42 / +1.90. The
            16/48 short keeps building while the slow longs decay, and the position goes from +5.8% to{' '}
            <span style={mono}>{neg('−4.3%')}</span>: a flat-price flow of <span style={mono}>{neg('−10.2 points')}</span>.
            The position turns short after just three flat days. A quiet market is enough to flip this model short.
          </p>
        </Step>

        <Step n={7} title="Scenarios">
          <Table head={['Horizon', 'Move', 'Price', 'Position after', 'Change']} rows={EX_SCEN.map(([h, k, px, ps, d]) => [
            h, k, px, sgn(ps, 1), sgn(d, 1),
          ])} />
          <p style={p}>
            A 1σ week is 0.87% × √5 = 1.95%. Selling is asymmetric: a 2σ fall next week takes the model 16% short and sells
            22 points of position, while it takes a 2σ <i>rally</i> merely to add 5.5 points; a +1σ week still leaves it
            selling, because the flat-price decay outweighs the rally.
          </p>
        </Step>

        <Step n={8} title="Dollars and contracts">
          <Formula>{`full risk   = $300bn × 0.60 × (25% / 11)              = $4.09bn of annual volatility
risk now    = +5.8% × $4.09bn                          = +$238m
notional    = $238m / 13.8%                            = +$1.72bn
contract    = 6,424.2 × $50                            = $321k   →  +5,346 contracts

flat 1w     = −10.2% × $4.09bn / 13.8%                 = −$3.0bn   →  −9,341 contracts
flow / ADV  = 9,341 / 1.5m (illustrative ADV)          = 0.6%`}</Formula>
          <p style={p}>
            Since the peak, the position has fallen by about 90 points: at today's volatility that is roughly
            90% × $4.09bn / 13.8% ≈ <span style={mono}>$27bn</span> of S&P futures sold over seven weeks, most of the
            trend followers' unwind already done. The remaining flows are large in dollars but small against S&P volume
            (0.6% of ADV). The same flow in a thinner market such as Hang Seng or OAT futures would be a much larger share
            of volume, which is what the Flow / ADV column is for.
          </p>
        </Step>

        <Step n={9} title="Putting it together">
          <p style={{ ...p, marginBottom: 0 }}>
            CTAs have already sold most of their S&P long; the model is barely long, in a confirmed reversal, and will
            drift short even if the market goes nowhere. Further downside (−2σ in a week) would add about $6.5bn of selling,
            against roughly $27bn already sold since the peak, so most of the forced unwind is done. A rally needs to be
            more than 1σ a week just to stop the selling. Trend followers are now a much smaller source of further
            selling than they were near the peak.
          </p>
        </Step>
      </Section>

      <Section id="reading" title="Reading the monitor">
        <Table head={['Question', 'Where to look']} left={2} rows={[
          ['Where are CTAs most crowded?', 'Sort by CTA position; look for Strong momentum · stretched rows.'],
          ['What could flip soon?', 'Sort by Flip at: amber σ values are within 1.5σ of a flip tomorrow.'],
          ['Who is already unwinding?', 'Reversal and Fading rows, a negative Δ1w on longs (positive on shorts), a rolling-over sparkline.'],
          ['What trades next week regardless?', 'Sort by Flat 1w flow; the 0σ column of the sector card adds it up by sector.'],
          ['What if the market moves?', 'The sector card\'s ±1σ / ±2σ columns; click a row for that market\'s full scenario grid.'],
          ['Will it move the market?', 'Flow / ADV: above 10% (amber) the flow is a noticeable share of normal volume.'],
          ['How much to trust the dollars?', 'The out-of-sample R² on the calibration card, and the P&L drawdown.'],
        ]} />
        <p style={p}>
          Group chips filter the table; column headers sort it (Flip at sorts nearest first). Clicking a row opens that
          market in the Single Series tab with the full history, per-speed flips, flat days to flip, the scenario grid and
          contract sizing.
        </p>
      </Section>

      <Section id="limits" title="Limitations">
        <ul style={{ ...p, paddingLeft: 18 }}>
          <li>One stylised CTA. Real funds differ in speeds, carry overlays, risk targets, market lists and execution;
            the model approximates the industry average, not any fund.</li>
          <li>Volatility is held at today's level in flips and scenarios. In a real shock, volatility rises and CTAs cut
            further, so flows in large moves are probably <i>understated</i>.</li>
          <li>Scenario paths are straight lines. A volatile path to the same end-point would give a slightly different
            position.</li>
          <li>The P&L is the trend signal only: no transaction costs, carry, roll yield or interest on cash.</li>
          <li>Dollar figures scale with the AUM input and the leverage from the calibration. Directions, regimes, flips and
            percentage flows do not depend on either.</li>
          <li>Simulated data (shown in the toolbar) are for testing the page only.</li>
        </ul>
      </Section>
    </div>
  )
}
