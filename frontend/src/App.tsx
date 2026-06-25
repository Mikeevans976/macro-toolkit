import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import SwapsRV from './pages/SwapsRV'
import EuroAreaHeatmap from './pages/EuroAreaHeatmap'
import GlobalYields from './pages/GlobalYields'
import OptionDerivedCDF from './pages/OptionDerivedCDF'
import FairValueModels from './pages/FairValueModels'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('access_token')
  if (!token) {
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
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
        <Route path="/tools/euro-area-heatmap" element={<ProtectedRoute><EuroAreaHeatmap /></ProtectedRoute>} />
        <Route path="/tools/global-yields" element={<ProtectedRoute><GlobalYields /></ProtectedRoute>} />
        <Route path="/tools/option-derived-cdf" element={<ProtectedRoute><OptionDerivedCDF /></ProtectedRoute>} />
        <Route path="/tools/fair-value-models" element={<ProtectedRoute><FairValueModels /></ProtectedRoute>} />
        {/* Catch-all: redirect unknown paths to dashboard */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
