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
  { slug: 'us-gdp', toolId: 'us-gdp-nowcast', title: 'US GDP Nowcast', country: 'US', variable: 'growth' },
]

// Debt sustainability monitors (DsaPage, GET /api/tools/quant-macro/dsa/{country}).
export const DSA_COUNTRIES = [
  { country: 'uk', toolId: 'uk-debt-sustainability', title: 'UK Debt Sustainability', flag: 'GB' as CountryCode },
]

// Labour market nowcasts (LabourPage, GET /api/tools/quant-macro/labour/{country}).
export const LABOUR_COUNTRIES = [
  { country: 'uk', toolId: 'uk-labour-nowcast', title: 'UK Labour Market Nowcast', flag: 'GB' as CountryCode },
  { country: 'us', toolId: 'us-labour-nowcast', title: 'US Labour Market Nowcast', flag: 'US' as CountryCode },
]
