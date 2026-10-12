import { Category } from '../types'
import { categoryColor } from '../theme'
import ToolTile from './ToolTile'

interface Props {
  category: Category
}

export default function CategoryCard({ category }: Props) {
  const mark = categoryColor[category.id] ?? category.color

  return (
    <section className="hub-frame px-4 pt-3.5 pb-2.5">
      <header className="flex items-center gap-2.5 pb-2.5 mb-1.5 border-b border-hairline">
        <span className="w-[8px] h-[8px] rounded-[2px] flex-shrink-0" style={{ background: mark }} />
        <h2 className="text-[12.5px] font-medium tracking-[0.02em] m-0" style={{ color: mark }}>{category.name}</h2>
        <span className="ml-auto hub-num text-[11px] text-fg-3">
          {String(category.tools.length).padStart(2, '0')}
        </span>
      </header>

      {category.tools.length === 0 ? (
        <p className="py-2 text-[12px] text-fg-4">No tools yet</p>
      ) : (
        <div className="grid">
          {category.tools.map((tool) => (
            <ToolTile key={tool.id} tool={tool} categoryId={category.id} />
          ))}
        </div>
      )}
    </section>
  )
}
