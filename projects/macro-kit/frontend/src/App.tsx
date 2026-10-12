import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import AppShell from './components/AppShell'
import SwapsRV from './pages/SwapsRV'
import EGBRV from './pages/EGBRV'
import EuroAreaHeatmap from './pages/EuroAreaHeatmap'
import GlobalYields from './pages/GlobalYields'
import OptionDerivedCDF from './pages/OptionDerivedCDF'
import FairValueModels from './pages/FairValueModels'
import UKHeatmap from './pages/UKHeatmap'
import USHeatmap from './pages/USHeatmap'
import JapanHeatmap from './pages/JapanHeatmap'
import SeasonalityBacktester from './pages/SeasonalityBacktester'
import PrintAnalysis from './pages/PrintAnalysis'
import Momentum from './pages/Momentum'
import CanadaHeatmap from './pages/CanadaHeatmap'
import SwedenHeatmap from './pages/SwedenHeatmap'
import NorwayHeatmap from './pages/NorwayHeatmap'
import SwitzerlandHeatmap from './pages/SwitzerlandHeatmap'
import AustraliaHeatmap from './pages/AustraliaHeatmap'
import NewZealandHeatmap from './pages/NewZealandHeatmap'
import InflationPCA from './pages/InflationPCA'
import InflationFixingsMonitor from './pages/InflationFixingsMonitor'
import MeanReversion from './pages/MeanReversion'
import PCAAnalysis from './pages/PCAAnalysis'
import CorrelationRegimes from './pages/CorrelationRegimes'
import FittedBondCurves from './pages/FittedBondCurves'
import AgentsPod from './pages/AgentsPod'
import AgentPage from './pages/AgentPage'
import MacroOptionsMonitor from './pages/MacroOptionsMonitor'
import PositioningTracker from './pages/PositioningTracker'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('access_token')
  if (!token) {
    return <Navigate to="/login" replace />
  }
  return <AppShell>{children}</AppShell>
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
