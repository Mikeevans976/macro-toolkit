/** Styling shared by the regional macro heatmap pages (previously duplicated in each). */
import type { CSSProperties } from 'react'

export const cardStyle: CSSProperties = {
  background: 'rgba(200,220,240,0.03)',
  border: '1px solid rgba(200,220,240,0.07)',
  borderRadius: 6, padding: 24,
}

/** Background for sticky table columns; must be opaque. */
export const stickyBg = '#07090c'

/** Dark-ground diverging scale: warm = above normal, cool = below. */
export function zscoreToColors(z: number): { bg: string; fg: string } {
  if (z >= 2.0)  return { bg: '#a85a4b', fg: '#fbeee9' }
  if (z >= 1.0)  return { bg: '#7a4a42', fg: '#f1ddd7' }
  if (z >= 0.5)  return { bg: '#3f3034', fg: '#e4c9c2' }
  if (z > -0.5)  return { bg: '#151b23', fg: '#c6ced8' }
  if (z > -1.0)  return { bg: '#22303d', fg: '#bcd6e6' }
  if (z > -2.0)  return { bg: '#2f5670', fg: '#e3f0f7' }
  return           { bg: '#4a86a8', fg: '#f2f9fc' }
}
