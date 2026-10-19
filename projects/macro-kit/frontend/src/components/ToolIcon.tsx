import Glyph, { toolGlyph } from './Glyph'
import CountryFlag from './CountryFlag'
import { TOOL_COUNTRY } from '../features/heatmap/regions'
import { categoryColor } from '../theme'

// Tool icon: country flag for regional heatmaps, otherwise a glyph tinted
// with its category colour on a soft tile of the same hue.

interface Props {
  toolId: string
  categoryId?: string
  size?: number
  tile?: boolean
}

function tint(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return `rgba(134,192,222,${alpha})`
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`
}

export default function ToolIcon({ toolId, categoryId, size = 18, tile = true }: Props) {
  const country = TOOL_COUNTRY[toolId]
  const color = (categoryId && categoryColor[categoryId]) || '#86c0de'
  const box = size + 10

  const inner = country ? (
    <CountryFlag country={country} height={Math.round(size * 0.72)} />
  ) : (
    <Glyph name={toolGlyph(toolId)} size={size} style={{ color }} />
  )

  if (!tile) return inner

  return (
    <span
      style={{
        width: box,
        height: box,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 6,
        background: country ? 'rgba(200,220,240,0.06)' : tint(color, 0.12),
        border: `1px solid ${country ? 'rgba(200,220,240,0.1)' : tint(color, 0.22)}`,
      }}
    >
      {inner}
    </span>
  )
}
