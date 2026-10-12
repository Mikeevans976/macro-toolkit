import axios from 'axios'
import { DashboardConfig, Tool } from './types'

// One cached fetch of the nav config, shared by the launchpad and the ⌘K palette.
let configPromise: Promise<DashboardConfig> | null = null

export function loadDashboardConfig(): Promise<DashboardConfig> {
  if (!configPromise) {
    const token = localStorage.getItem('access_token')
    configPromise = axios
      .get<DashboardConfig>('/api/dashboard', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.data)
      .catch((err) => {
        configPromise = null
        throw err
      })
  }
  return configPromise
}

export function clearDashboardConfig() {
  configPromise = null
}

export interface FlatTool extends Tool {
  categoryId: string
  categoryName: string
}

export function flattenTools(config: DashboardConfig): FlatTool[] {
  return config.categories.flatMap((c) =>
    c.tools.map((t) => ({ ...t, categoryId: c.id, categoryName: c.name })),
  )
}

// Recently opened tools (per browser, convenience only)
const RECENT_KEY = 'hub_recent_tools'

export function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

export function pushRecent(url: string) {
  try {
    const next = [url, ...readRecent().filter((u) => u !== url)].slice(0, 5)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
}
