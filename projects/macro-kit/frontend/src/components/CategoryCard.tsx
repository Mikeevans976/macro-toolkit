import { Category } from '../types'
import ToolTile from './ToolTile'

interface Props {
  category: Category
}

export default function CategoryCard({ category }: Props) {
  // Convert hex color to rgba for the card border / accent
  function hexToRgba(hex: string, alpha: number): string {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    if (!result) return `rgba(255,255,255,${alpha})`
    return `rgba(${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)},${alpha})`
  }

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${hexToRgba(category.color, 0.18)}`,
      }}
    >
      {/* Category header */}
      <div
        className="px-5 py-4 flex items-center gap-3"
        style={{
          background: hexToRgba(category.color, 0.08),
          borderBottom: `1px solid ${hexToRgba(category.color, 0.15)}`,
        }}
      >
        <div
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{
            background: category.color,
            boxShadow: `0 0 8px ${hexToRgba(category.color, 0.7)}`,
          }}
        />
        <h3 className="text-sm font-semibold text-white tracking-wide">
          {category.name}
        </h3>
        <span
          className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full"
          style={{
            background: hexToRgba(category.color, 0.15),
            color: category.color,
          }}
        >
          {category.tools.length}
        </span>
      </div>

      {/* Tools grid */}
      <div className="p-4 grid grid-cols-3 sm:grid-cols-4 gap-2">
        {category.tools.map((tool) => (
          <ToolTile
            key={tool.id}
            tool={tool}
            categoryColor={category.color}
          />
        ))}
      </div>
    </div>
  )
}
