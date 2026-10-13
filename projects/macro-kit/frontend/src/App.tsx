import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import AppShell from './components/AppShell'

// Pages are code-split: each tool loads (and builds its synthetic data) only when opened.
const SwapsRV = lazy(() => import('./pages/SwapsRV'))
const EGBRV = lazy(() => import('./pages/EGBRV'))
const EuroAreaHeatmap = lazy(() => import('./pages/EuroAreaHeatmap'))
const GlobalYields = lazy(() => import('./pages/GlobalYields'))
const OptionDerivedCDF = lazy(() => import('./pages/OptionDerivedCDF'))
const FairValueModels = lazy(() => import('./pages/FairValueModels'))
const UKHeatmap = lazy(() => import('./pages/UKHeatmap'))
const USHeatmap = lazy(() => import('./pages/USHeatmap'))
const JapanHeatmap = lazy(() => import('./pages/JapanHeatmap'))
const SeasonalityBacktester = lazy(() => import('./pages/SeasonalityBacktester'))
const PrintAnalysis = lazy(() => import('./pages/PrintAnalysis'))
const Momentum = lazy(() => import('./pages/Momentum'))
const CanadaHeatmap = lazy(() => import('./pages/CanadaHeatmap'))
const SwedenHeatmap = lazy(() => import('./pages/SwedenHeatmap'))
const NorwayHeatmap = lazy(() => import('./pages/NorwayHeatmap'))
const SwitzerlandHeatmap = lazy(() => import('./pages/SwitzerlandHeatmap'))
const AustraliaHeatmap = lazy(() => import('./pages/AustraliaHeatmap'))
const NewZealandHeatmap = lazy(() => import('./pages/NewZealandHeatmap'))
const InflationPCA = lazy(() => import('./pages/InflationPCA'))
const InflationFixingsMonitor = lazy(() => import('./pages/InflationFixingsMonitor'))
const MeanReversion = lazy(() => import('./pages/MeanReversion'))
const PCAAnalysis = lazy(() => import('./pages/PCAAnalysis'))
const CorrelationRegimes = lazy(() => import('./pages/CorrelationRegimes'))
const FittedBondCurves = lazy(() => import('./pages/FittedBondCurves'))
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
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route path="/tools/swaps-rv" element={<ProtectedRoute><SwapsRV /></ProtectedRoute>} />
        <Route path="/tools/egb-rv" element={<ProtectedRoute><EGBRV /></ProtectedRoute>} />
        <Route path="/tools/euro-area-heatmap" element={<ProtectedRoute><EuroAreaHeatmap /></ProtectedRoute>} />
        <Route path="/tools/uk-heatmap" element={<ProtectedRoute><UKHeatmap /></ProtectedRoute>} />
        <Route path="/tools/us-heatmap" element={<ProtectedRoute><USHeatmap /></ProtectedRoute>} />
        <Route path="/tools/japan-heatmap" element={<ProtectedRoute><JapanHeatmap /></ProtectedRoute>} />
        <Route path="/tools/canada-heatmap" element={<ProtectedRoute><CanadaHeatmap /></ProtectedRoute>} />
        <Route path="/tools/sweden-heatmap" element={<ProtectedRoute><SwedenHeatmap /></ProtectedRoute>} />
        <Route path="/tools/norway-heatmap" element={<ProtectedRoute><NorwayHeatmap /></ProtectedRoute>} />
        <Route path="/tools/switzerland-heatmap" element={<ProtectedRoute><SwitzerlandHeatmap /></ProtectedRoute>} />
        <Route path="/tools/australia-heatmap" element={<ProtectedRoute><AustraliaHeatmap /></ProtectedRoute>} />
        <Route path="/tools/new-zealand-heatmap" element={<ProtectedRoute><NewZealandHeatmap /></ProtectedRoute>} />
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
        <Route path="/tools/correlation-regimes" element={<ProtectedRoute><CorrelationRegimes /></ProtectedRoute>} />
        <Route path="/tools/fitted-bond-curves" element={<ProtectedRoute><FittedBondCurves /></ProtectedRoute>} />
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
