import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { LoadingState } from './LoadingState'

export function RequireAuth() {
  const { user, loading, authError, authProgress } = useAuth()

  // `full` variant: no sidebar exists yet at this point, so this is a splash.
  if (loading) {
    return <LoadingState variant="full" progress={authProgress} onRetryNow={() => window.location.reload()} />
  }
  if (authError) {
    return <LoadingState variant="full" progress={authProgress} onRetryNow={() => window.location.reload()} />
  }
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}
