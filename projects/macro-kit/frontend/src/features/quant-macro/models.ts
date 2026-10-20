// Quant Macro models, one per (market, variable). Each generates a /tools/{toolId}
// route in App.tsx and reads GET /api/tools/quant-macro/{slug}. Add new models here
// and in backend/quant_macro.py (MODELS), plus a tile in dashboard_config.yaml.
import type { CountryCode } from '../heatmap/regions'

export interface QuantMacroModel {
  slug: string          // backend model key
  toolId: string        // dashboard tool id and route
  title: string
  country: CountryCode
  variable: 'growth' | 'inflation' | 'labour'
}

export const QUANT_MACRO_CATEGORY = { id: 'quant-macro', name: 'Quant Macro' } as const

export const QUANT_MACRO_MODELS: QuantMacroModel[] = [
  { slug: 'uk-gdp', toolId: 'uk-gdp-nowcast', title: 'UK GDP Nowcast', country: 'GB', variable: 'growth' },
]
