/** Regions with a macro heatmap. Slugs match backend/heatmap_regions.py and the
 *  /tools/{slug}-heatmap routes in dashboard_config.yaml. */
export const HEATMAP_REGIONS = [
  { slug: 'euro-area', name: 'Euro Area' },
  { slug: 'uk', name: 'United Kingdom' },
  { slug: 'us', name: 'United States' },
  { slug: 'japan', name: 'Japan' },
  { slug: 'canada', name: 'Canada' },
  { slug: 'sweden', name: 'Sweden' },
  { slug: 'norway', name: 'Norway' },
  { slug: 'switzerland', name: 'Switzerland' },
  { slug: 'australia', name: 'Australia' },
  { slug: 'new-zealand', name: 'New Zealand' },
] as const

export type HeatmapRegion = typeof HEATMAP_REGIONS[number]['slug']
