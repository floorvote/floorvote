import { Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import Login from './pages/Login'
import Layout from './components/Layout'
import Overview from './pages/Overview'
import Sync from './pages/Sync'
import Tenants from './pages/Tenants'
import TenantDetail from './pages/TenantDetail'
import Adoption from './pages/Adoption'
import Settings from './pages/Settings'
import Budget from './pages/Budget'
import OpsHealth from './pages/OpsHealth'
import UnknownLogins from './pages/UnknownLogins'
import DashVerify from './pages/DashVerify'

function Gate() {
  const { identity, loading } = useAuth()
  if (loading) return <div style={{ padding: 40, color: 'var(--muted)' }}>Loading…</div>
  if (!identity) return <Login />
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/sync" element={<Sync />} />
        <Route path="/adoption" element={<Adoption />} />
        <Route path="/tenants" element={<Tenants />} />
        <Route path="/tenants/:id" element={<TenantDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/budget" element={<Budget />} />
        <Route path="/ops-health" element={<OpsHealth />} />
        <Route path="/unknown-logins" element={<UnknownLogins />} />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Two-step magic-link interstitial — reachable pre-auth, before the gate. */}
        <Route path="/auth/verify" element={<DashVerify />} />
        <Route path="*" element={<Gate />} />
      </Routes>
    </AuthProvider>
  )
}
