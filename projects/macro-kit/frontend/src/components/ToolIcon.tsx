import Glyph, { TOOL_FLAG, toolGlyph } from './Glyph'
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
  const flag = TOOL_FLAG[toolId]
  const color = (categoryId && categoryColor[categoryId]) || '#86c0de'
  const box = size + 10

  const inner = flag ? (
    <span style={{ fontSize: size * 0.95, lineHeight: 1, filter: 'saturate(0.9)' }} aria-hidden="true">{flag}</span>
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
        background: flag ? 'rgba(200,220,240,0.06)' : tint(color, 0.12),
        border: `1px solid ${flag ? 'rgba(200,220,240,0.1)' : tint(color, 0.22)}`,
      }}
    >
      {inner}
    </span>
  )
}
