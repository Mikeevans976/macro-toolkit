import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Tool } from '../types'

interface Props {
  tool: Tool
  categoryColor: string
}

function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return `rgba(255,255,255,${alpha})`
  return `rgba(${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)},${alpha})`
}

export default function ToolTile({ tool, categoryColor }: Props) {
  const [hovered, setHovered] = useState(false)

  return (
    <Link
      to={tool.url}
      className="flex flex-col items-center justify-center gap-2 rounded-xl p-3 text-center transition-all duration-200 select-none"
      style={{
        background: hovered
          ? hexToRgba(categoryColor, 0.12)
          : 'rgba(255,255,255,0.04)',
        border: `1px solid ${hovered ? hexToRgba(categoryColor, 0.35) : 'rgba(255,255,255,0.06)'}`,
        transform: hovered ? 'translateY(-2px) scale(1.03)' : 'none',
        boxShadow: hovered
          ? `0 4px 20px ${hexToRgba(categoryColor, 0.25)}, 0 0 0 1px ${hexToRgba(categoryColor, 0.2)}`
          : 'none',
        textDecoration: 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className="text-3xl leading-none"
        style={{
          filter: hovered ? `drop-shadow(0 0 6px ${hexToRgba(categoryColor, 0.8)})` : 'none',
          transition: 'filter 0.2s',
        }}
      >
        {tool.icon}
      </span>
      <span
        className="text-xs font-medium leading-tight"
        style={{
          color: hovered ? '#e2e8f0' : '#94a3b8',
          transition: 'color 0.2s',
        }}
      >
        {tool.name}
      </span>
    </Link>
  )
}
