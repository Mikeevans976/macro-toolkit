// Analytics Hub design tokens for JS / inline styles / Recharts props.
// Mirrors the CSS variables in index.css — keep the two in sync.

export const ink = {
  0: '#07090c',
  1: '#0b0f14',
  2: '#10161d',
  3: '#18202a',
} as const

export const fg = {
  1: '#e4eaf1',
  2: '#c6ced8',
  3: '#9aa5b1',
  4: '#77828f',
} as const

export const line = 'rgba(150,178,205,0.09)'
export const line2 = 'rgba(150,178,205,0.17)'

export const accent = '#86c0de'
export const pos = '#6fc2a2'
export const neg = '#e2826f'
export const warn = '#d6ad66'

export const fontUi = "'Geist', 'Helvetica Neue', Arial, sans-serif"
export const fontNum = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace"

// Category marks: equal lightness / chroma, keyed by dashboard_config.yaml category id
export const categoryColor: Record<string, string> = {
  agents: '#9e9fe2',
  supply: '#82b1dd',
  funding: '#b79fdb',
  'futures-swaps-vol': '#74c1a6',
  'market-structure': '#d59fbf',
  backtesters: '#6fc0cb',
  global: '#d3b26e',
  'macro-fundamentals': '#dd8a7d',
  technicals: '#a7b6e6',
  'inflation-markets': '#dd9f78',
}

// Ordered series palette for multi-line charts
export const series = ['#86c0de', '#d6ad66', '#b79fdb', '#6fc2a2', '#dd8a7d', '#a7b6e6', '#d59fbf', '#6fc0cb']

// Shared Recharts props
export const chart = {
  grid: { stroke: 'rgba(150,178,205,0.07)', strokeDasharray: '2 4', vertical: false },
  axis: {
    stroke: 'rgba(150,178,205,0.14)',
    tick: { fill: fg[3], fontSize: 10, fontFamily: fontNum },
    tickLine: false,
  },
  tooltip: {
    contentStyle: {
      background: 'rgba(11,15,20,0.94)',
      border: `1px solid ${line2}`,
      borderRadius: 6,
      fontFamily: fontNum,
      fontSize: 11,
      color: fg[1],
    },
    labelStyle: { color: fg[3], marginBottom: 4 },
    itemStyle: { color: fg[1], padding: 0 },
    cursor: { stroke: 'rgba(150,178,205,0.22)', strokeWidth: 1 },
  },
} as const
