import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export function RequireAuth() {
  const { user, loading, authError } = useAuth()

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>
  if (authError) return <div style={{ padding: 32 }}>Unable to connect. Please refresh the page.</div>
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}
