import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import AppShell from './components/AppShell'
import { HEATMAP_REGIONS } from './features/heatmap/regions'
import { DSA_COUNTRIES, LABOUR_COUNTRIES, QUANT_MACRO_MODELS } from './features/quant-macro/models'

// Pages are code-split: each tool loads (and builds its synthetic data) only when opened.
const RegionalHeatmapPage = lazy(() => import('./features/heatmap/RegionalHeatmapPage'))
const NowcastPage = lazy(() => import('./features/quant-macro/NowcastPage'))
const DsaPage = lazy(() => import('./features/quant-macro/DsaPage'))
const LabourPage = lazy(() => import('./features/quant-macro/LabourPage'))
const SwapsRV = lazy(() => import('./pages/SwapsRV'))
const EGBRV = lazy(() => import('./pages/EGBRV'))
const GlobalYields = lazy(() => import('./pages/GlobalYields'))
const OptionDerivedCDF = lazy(() => import('./pages/OptionDerivedCDF'))
const FairValueModels = lazy(() => import('./pages/FairValueModels'))
const SeasonalityBacktester = lazy(() => import('./pages/SeasonalityBacktester'))
const PrintAnalysis = lazy(() => import('./pages/PrintAnalysis'))
const Momentum = lazy(() => import('./pages/Momentum'))
const InflationPCA = lazy(() => import('./pages/InflationPCA'))
const InflationFixingsMonitor = lazy(() => import('./pages/InflationFixingsMonitor'))
const MeanReversion = lazy(() => import('./pages/MeanReversion'))
const PCAAnalysis = lazy(() => import('./pages/PCAAnalysis'))
const FXIPCA = lazy(() => import('./pages/FXIPCA'))
const CorrelationRegimes = lazy(() => import('./pages/CorrelationRegimes'))
const FittedBondCurves = lazy(() => import('./pages/FittedBondCurves'))
const SwapSpreads = lazy(() => import('./pages/SwapSpreads'))
const AgentsPod = lazy(() => import('./pages/AgentsPod'))
const AgentPage = lazy(() => import('./pages/AgentPage'))
const MacroOptionsMonitor = lazy(() => import('./pages/MacroOptionsMonitor'))
const PositioningTracker = lazy(() => import('./pages/PositioningTracker'))

function PageLoading() {
  return (
    <div role="status" aria-live="polite" className="hub-eyebrow" style={{ padding: 32 }}>
      Loading…
    </div>
  )
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('access_token')
  if (!token) {
    return <Navigate to="/login" replace />
  }
  return (
    <AppShell>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </AppShell>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Launchpad sections; /tools (no slash) is the tool index, /tools/<id> the tools themselves */}
        <Route path="/" element={<ProtectedRoute><Dashboard view="summary" /></ProtectedRoute>} />
        <Route path="/agents" element={<ProtectedRoute><Dashboard view="agents" /></ProtectedRoute>} />
        <Route path="/tools" element={<ProtectedRoute><Dashboard view="tools" /></ProtectedRoute>} />
        {HEATMAP_REGIONS.map(r => (
          <Route key={r.slug} path={`/tools/${r.slug}-heatmap`} element={<ProtectedRoute><RegionalHeatmapPage region={r.slug} /></ProtectedRoute>} />
        ))}
        {QUANT_MACRO_MODELS.map(m => (
          <Route key={m.slug} path={`/tools/${m.toolId}`} element={<ProtectedRoute><NowcastPage slug={m.slug} /></ProtectedRoute>} />
        ))}
        {DSA_COUNTRIES.map(c => (
          <Route key={c.toolId} path={`/tools/${c.toolId}`} element={<ProtectedRoute><DsaPage country={c.country} /></ProtectedRoute>} />
        ))}
        {LABOUR_COUNTRIES.map(c => (
          <Route key={c.toolId} path={`/tools/${c.toolId}`} element={<ProtectedRoute><LabourPage country={c.country} /></ProtectedRoute>} />
        ))}
        <Route path="/tools/swaps-rv" element={<ProtectedRoute><SwapsRV /></ProtectedRoute>} />
        <Route path="/tools/egb-rv" element={<ProtectedRoute><EGBRV /></ProtectedRoute>} />
        <Route path="/tools/global-yields" element={<ProtectedRoute><GlobalYields /></ProtectedRoute>} />
        <Route path="/tools/option-derived-cdf" element={<ProtectedRoute><OptionDerivedCDF /></ProtectedRoute>} />
        <Route path="/tools/fair-value-models" element={<ProtectedRoute><FairValueModels /></ProtectedRoute>} />
        <Route path="/tools/seasonality" element={<ProtectedRoute><SeasonalityBacktester /></ProtectedRoute>} />
        <Route path="/tools/print-analysis" element={<ProtectedRoute><PrintAnalysis /></ProtectedRoute>} />
        <Route path="/tools/momentum" element={<ProtectedRoute><Momentum /></ProtectedRoute>} />
        <Route path="/tools/inflation-pca" element={<ProtectedRoute><InflationPCA /></ProtectedRoute>} />
        <Route path="/tools/inflation-fixings" element={<ProtectedRoute><InflationFixingsMonitor /></ProtectedRoute>} />
        <Route path="/tools/mean-reversion" element={<ProtectedRoute><MeanReversion /></ProtectedRoute>} />
        <Route path="/tools/pca-analysis" element={<ProtectedRoute><PCAAnalysis /></ProtectedRoute>} />
        <Route path="/tools/fx-ipca" element={<ProtectedRoute><FXIPCA /></ProtectedRoute>} />
        <Route path="/tools/correlation-regimes" element={<ProtectedRoute><CorrelationRegimes /></ProtectedRoute>} />
        <Route path="/tools/fitted-bond-curves" element={<ProtectedRoute><FittedBondCurves /></ProtectedRoute>} />
        <Route path="/tools/swap-spreads" element={<ProtectedRoute><SwapSpreads /></ProtectedRoute>} />
        <Route path="/tools/agents/fixed-income-pod" element={<ProtectedRoute><AgentsPod /></ProtectedRoute>} />
        {/* Individual agent pages — specific pod route must come before the wildcard :agentId */}
        <Route path="/tools/agents/:agentId" element={<ProtectedRoute><AgentPage /></ProtectedRoute>} />
        <Route path="/tools/macro-options-monitor" element={<ProtectedRoute><MacroOptionsMonitor /></ProtectedRoute>} />
        <Route path="/tools/euribor-positioning" element={<ProtectedRoute><PositioningTracker /></ProtectedRoute>} />
        {/* Catch-all: redirect unknown paths to dashboard */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
