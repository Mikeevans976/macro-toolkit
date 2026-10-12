// Monoline glyph set for the Analytics Hub (20×20 grid, 1.25px stroke).
// Tools map to glyphs by id in TOOL_GLYPH; unknown ids fall back to 'dot'.

type GlyphName =
  | 'pod' | 'globe' | 'rv' | 'thermo' | 'radar' | 'target' | 'swap' | 'columns'
  | 'wave' | 'pca' | 'link' | 'ou' | 'curve' | 'lattice' | 'cdf' | 'calendar'
  | 'ledger' | 'heatmap' | 'candles' | 'trend' | 'balance' | 'pin'
  | 'agent' | 'home' | 'search' | 'logout' | 'arrow' | 'dot' | 'close'
  | 'shield' | 'crown' | 'front' | 'send'

const PATHS: Record<GlyphName, JSX.Element> = {
  pod: (<><circle cx="10" cy="10" r="2.2" /><circle cx="4" cy="5" r="1.4" /><circle cx="16" cy="5" r="1.4" /><circle cx="4" cy="15" r="1.4" /><circle cx="16" cy="15" r="1.4" /><path d="M5.2 5.8 8.2 8.6M14.8 5.8l-3 2.8M5.2 14.2l3-2.8M14.8 14.2l-3-2.8" /></>),
  globe: (<><circle cx="10" cy="10" r="7" /><ellipse cx="10" cy="10" rx="3" ry="7" /><path d="M3 10h14" /></>),
  rv: (<><path d="M3 16 16 3v13z" /><path d="M12 16v-2M9 16v-1.5M13.5 10.5H15" /></>),
  thermo: (<><path d="M8.5 11.5V4a1.5 1.5 0 0 1 3 0v7.5a3 3 0 1 1-3 0z" /><path d="M10 9v4.5" /><path d="M14 5h2M14 8h2" /></>),
  radar: (<><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /><path d="M10 10 15 5" /><circle cx="13" cy="12.5" r=".8" fill="currentColor" stroke="none" /></>),
  target: (<><path d="M10 2v4M10 14v4M2 10h4M14 10h4" /><circle cx="10" cy="10" r="5" /></>),
  swap: (<><path d="M3 7h12l-3-3M17 13H5l3 3" /></>),
  columns: (<><path d="M3 7.5 10 3.5l7 4M4 17h12M5.5 8.5v6M10 8.5v6M14.5 8.5v6" /></>),
  wave: (<><path d="M2 14c4 0 4-9 8-9s4 9 8 9" /><path d="M10 5v11" strokeDasharray="1.5 2" /></>),
  pca: (<><path d="M3 15 17 5M7 4l6 12" /><circle cx="10" cy="10" r="1.2" /></>),
  link: (<><circle cx="6.5" cy="10" r="3.5" /><circle cx="13.5" cy="10" r="3.5" /></>),
  ou: (<><path d="M2 10h16" strokeDasharray="1.5 2" /><path d="M2 5c3 0 3 10 6 10s3-8 5-8 2 5 5 3" /></>),
  curve: (<><path d="M3 17V3M3 17h14" /><path d="M5 14c2-5 5-7 11-8" /><circle cx="7.5" cy="10.5" r=".8" fill="currentColor" stroke="none" /><circle cx="12" cy="7.6" r=".8" fill="currentColor" stroke="none" /></>),
  lattice: (<><circle cx="10" cy="10" r="7" /><path d="M3.5 7.5h13M3.5 12.5h13" /><path d="M10 3c-2.5 2-2.5 12 0 14M10 3c2.5 2 2.5 12 0 14" /></>),
  cdf: (<><path d="M3 17h14M3 17V3" /><path d="M4 15.5c4 0 4-10 8-10.5h4" /><path d="M10 17v-7" strokeDasharray="1.5 2" /></>),
  calendar: (<><rect x="3" y="4" width="14" height="13" rx="1.5" /><path d="M3 8h14M7 2.5v3M13 2.5v3M6 11h2M9.5 11h2M13 11h1M6 14h2M9.5 14h2" /></>),
  ledger: (<><rect x="4" y="2.5" width="12" height="15" rx="1.5" /><path d="M7 6.5h6M7 9.5h6M7 12.5h4" /></>),
  heatmap: (<><rect x="3" y="3" width="14" height="14" rx="1.5" /><path d="M3 7.7h14M3 12.3h14M7.7 3v14M12.3 3v14" /><rect x="8.2" y="8.2" width="3.6" height="3.6" fill="currentColor" stroke="none" opacity=".55" /></>),
  candles: (<><path d="M5 3v14M10 5v12M15 2v12" /><rect x="3.5" y="6" width="3" height="6" rx=".5" /><rect x="8.5" y="8" width="3" height="5" rx=".5" /><rect x="13.5" y="4" width="3" height="6" rx=".5" /></>),
  trend: (<><path d="M3 15 8 10l3 3 6-6" /><path d="M13 7h4v4" /></>),
  balance: (<><path d="M10 3v14M6 17h8M4 6h12" /><path d="M4 6 2 11a2.2 2.2 0 0 0 4 0zM16 6l-2 5a2.2 2.2 0 0 0 4 0z" /></>),
  pin: (<><path d="M3 17h14" /><path d="M6 17V9M10 17V5M14 17v-6" /><circle cx="10" cy="4" r="1.2" /></>),
  agent: (<><circle cx="10" cy="7" r="3" /><path d="M4 17c.8-3.3 3.2-5 6-5s5.2 1.7 6 5" /></>),
  home: (<><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></>),
  search: (<><circle cx="9" cy="9" r="5" /><path d="m13 13 4 4" /></>),
  logout: (<><path d="M8 4H4.5A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16H8" /><path d="M12 6.5 15.5 10 12 13.5M15.5 10H7.5" /></>),
  arrow: (<><path d="M4 10h12M12 6l4 4-4 4" /></>),
  dot: (<><circle cx="10" cy="10" r="2.5" /></>),
  close: (<><path d="m5 5 10 10M15 5 5 15" /></>),
  shield: (<><path d="M10 2.5 16 5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5z" /><path d="M7.5 10h5" /></>),
  crown: (<><path d="M3.5 15.5h13M4 13 3 6l4.2 3L10 4l2.8 5L17 6l-1 7z" /></>),
  front: (<><path d="M3 17V3M3 17h14" /><path d="M5 9h3v8M10 7h3v10M15 6h2" /></>),
  send: (<><path d="M10 16V4M5 9l5-5 5 5" /></>),
}

export const TOOL_GLYPH: Record<string, GlyphName> = {
  'fixed-income-pod': 'pod',
  'macro-strategist': 'globe',
  'rv-analyst': 'rv',
  'inflation-watcher': 'thermo',
  'positioning-monitor': 'radar',
  'crew-chief': 'target',
  'deputy-pm': 'crown',
  'red-team': 'shield',
  'head-of-macro-research': 'globe',
  'head-of-rates': 'target',
  'stir-strategist': 'front',
  'curve-strategist': 'curve',
  'swaps-rv-analyst': 'swap',
  'sovereign-spreads-analyst': 'columns',
  'inflation-strategist': 'thermo',
  'positioning-flows-analyst': 'radar',
  'pod-coordinator': 'link',
  cro: 'balance',
  'supply-funding-analyst': 'ledger',
  'trade-monitor': 'ledger',
  'news-scanner': 'search',
  'swaps-rv': 'swap',
  'egb-rv': 'columns',
  'macro-options-monitor': 'wave',
  'euribor-positioning': 'radar',
  'pca-analysis': 'pca',
  'correlation-regimes': 'link',
  'mean-reversion': 'ou',
  'fitted-bond-curves': 'curve',
  'global-yields': 'lattice',
  'option-derived-cdf': 'cdf',
  seasonality: 'calendar',
  'trade-blotter': 'ledger',
  'print-analysis': 'candles',
  momentum: 'trend',
  'fair-value-models': 'balance',
  'inflation-pca': 'pca',
  'inflation-fixings': 'pin',
}

// Country flags for the regional heatmaps
export const TOOL_FLAG: Record<string, string> = {
  'euro-area-heatmap': '🇪🇺',
  'uk-heatmap': '🇬🇧',
  'us-heatmap': '🇺🇸',
  'japan-heatmap': '🇯🇵',
  'canada-heatmap': '🇨🇦',
  'sweden-heatmap': '🇸🇪',
  'norway-heatmap': '🇳🇴',
  'switzerland-heatmap': '🇨🇭',
  'australia-heatmap': '🇦🇺',
  'new-zealand-heatmap': '🇳🇿',
}

export function toolGlyph(toolId: string): GlyphName {
  if (TOOL_GLYPH[toolId]) return TOOL_GLYPH[toolId]
  if (toolId.endsWith('-heatmap')) return 'heatmap'
  return 'dot'
}

interface Props {
  name: GlyphName
  size?: number
  className?: string
  style?: React.CSSProperties
  strokeWidth?: number
}

export default function Glyph({ name, size = 18, className, style, strokeWidth = 1.5 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0, ...style }}
    >
      {PATHS[name]}
    </svg>
  )
}

export type { GlyphName }
