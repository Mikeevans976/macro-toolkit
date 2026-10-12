import { Link } from 'react-router-dom'
import { Tool } from '../types'
import Glyph from './Glyph'
import ToolIcon from './ToolIcon'

interface Props {
  tool: Tool
  categoryId: string
}

export default function ToolTile({ tool, categoryId }: Props) {
  return (
    <Link
      to={tool.url}
      title={tool.description}
      className="group grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 -mx-2 px-2 py-[6px] rounded text-fg-1 no-underline transition-colors duration-150 hover:bg-ink-2"
    >
      <ToolIcon toolId={tool.id} categoryId={categoryId} size={16} />
      <span className="truncate text-[13.5px]">{tool.name}</span>
      <span className="text-accent opacity-0 -translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0">
        <Glyph name="arrow" size={14} />
      </span>
    </Link>
  )
}
