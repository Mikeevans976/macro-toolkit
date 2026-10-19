/** Regions with a macro heatmap. Slugs match backend/heatmap_regions.py and the
 *  /tools/{slug}-heatmap routes in dashboard_config.yaml; `country` is the
 *  ISO 3166 code (EU for the euro area) of the flag shown by CountryFlag. */
export const HEATMAP_REGIONS = [
  { slug: 'euro-area', name: 'Euro Area', bloc: 'dm', country: 'EU' },
  { slug: 'uk', name: 'United Kingdom', bloc: 'dm', country: 'GB' },
  { slug: 'us', name: 'United States', bloc: 'dm', country: 'US' },
  { slug: 'japan', name: 'Japan', bloc: 'dm', country: 'JP' },
  { slug: 'canada', name: 'Canada', bloc: 'dm', country: 'CA' },
  { slug: 'sweden', name: 'Sweden', bloc: 'dm', country: 'SE' },
  { slug: 'norway', name: 'Norway', bloc: 'dm', country: 'NO' },
  { slug: 'switzerland', name: 'Switzerland', bloc: 'dm', country: 'CH' },
  { slug: 'australia', name: 'Australia', bloc: 'dm', country: 'AU' },
  { slug: 'new-zealand', name: 'New Zealand', bloc: 'dm', country: 'NZ' },
  { slug: 'mexico', name: 'Mexico', bloc: 'em', country: 'MX' },
  { slug: 'china', name: 'China', bloc: 'em', country: 'CN' },
  { slug: 'india', name: 'India', bloc: 'em', country: 'IN' },
  { slug: 'brazil', name: 'Brazil', bloc: 'em', country: 'BR' },
  { slug: 'south-korea', name: 'South Korea', bloc: 'em', country: 'KR' },
  { slug: 'south-africa', name: 'South Africa', bloc: 'em', country: 'ZA' },
  { slug: 'poland', name: 'Poland', bloc: 'em', country: 'PL' },
  { slug: 'indonesia', name: 'Indonesia', bloc: 'em', country: 'ID' },
  { slug: 'hungary', name: 'Hungary', bloc: 'em', country: 'HU' },
  { slug: 'czech-republic', name: 'Czech Republic', bloc: 'em', country: 'CZ' },
  { slug: 'romania', name: 'Romania', bloc: 'em', country: 'RO' },
  { slug: 'turkey', name: 'Turkey', bloc: 'em', country: 'TR' },
  { slug: 'israel', name: 'Israel', bloc: 'em', country: 'IL' },
  { slug: 'chile', name: 'Chile', bloc: 'em', country: 'CL' },
  { slug: 'colombia', name: 'Colombia', bloc: 'em', country: 'CO' },
  { slug: 'peru', name: 'Peru', bloc: 'em', country: 'PE' },
  { slug: 'thailand', name: 'Thailand', bloc: 'em', country: 'TH' },
  { slug: 'malaysia', name: 'Malaysia', bloc: 'em', country: 'MY' },
  { slug: 'philippines', name: 'Philippines', bloc: 'em', country: 'PH' },
  { slug: 'taiwan', name: 'Taiwan', bloc: 'em', country: 'TW' },
] as const

export type HeatmapRegion = typeof HEATMAP_REGIONS[number]['slug']
export type CountryCode = typeof HEATMAP_REGIONS[number]['country']

/** Nav category of each bloc (dashboard_config.yaml category id and label). */
export const BLOC_CATEGORY = {
  dm: { id: 'macro-fundamentals', name: 'Macro Fundamentals' },
  em: { id: 'em-macro-fundamentals', name: 'EM Macro Fundamentals' },
} as const

/** Country code of a tool id, for the regional heatmaps ("mexico-heatmap" → "MX"). */
export const TOOL_COUNTRY: Record<string, CountryCode> = Object.fromEntries(
  HEATMAP_REGIONS.map(r => [`${r.slug}-heatmap`, r.country]),
)
