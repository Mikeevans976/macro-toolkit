import React from 'react'
import { categoryColor } from '../theme'

// Shared tool-page title block: category eyebrow, title, optional subtitle.
// Used inside each page's own sticky header.

interface Props {
  category: string
  categoryId?: string
  title: React.ReactNode
  subtitle?: React.ReactNode
  flag?: React.ReactNode       // e.g. <CountryFlag country="MX" />
}

export default function PageTitle({ category, categoryId, title, subtitle, flag }: Props) {
  const mark = categoryId ? categoryColor[categoryId] : undefined
  return (
    <div style={{ minWidth: 0, display: 'grid', gap: 3 }}>
      <div className="hub-eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10, color: mark ?? undefined }}>
        {mark && <span style={{ width: 6, height: 6, borderRadius: 1, background: mark, flexShrink: 0 }} />}
        {category}
      </div>
      <h1 style={{ margin: 0, fontSize: 17, fontWeight: 500, letterSpacing: '-0.02em', color: '#eef2f6', lineHeight: 1.2, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 9 }}>
        {flag}
        {title}
      </h1>
      {subtitle && (
        <div style={{ fontSize: 11, color: '#9aa5b1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subtitle}
        </div>
      )}
    </div>
  )
}

// Header bar shared by tool pages (sticky, translucent graphite, hairline base)
export const headerBar: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 100,
  background: 'rgba(7,9,12,0.86)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  borderBottom: '1px solid rgba(150,178,205,0.09)',
}
