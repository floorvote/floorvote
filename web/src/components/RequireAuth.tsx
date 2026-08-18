import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { LoadingState } from './LoadingState'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

export function RequireAuth() {
  const { user, loading, authError, authProgress } = useAuth()

  // `full` variant: no sidebar exists yet at this point, so this is a splash.
  if (loading) {
    return <LoadingState variant="full" progress={authProgress} onRetryNow={() => window.location.reload()} />
  }
  // Terminal, not transient — and the distinction is the whole reason this
  // branch cannot share the `loading` one's rendering. retryFetch keeps retrying
  // a 5xx or a stall forever, so anything that gets here is a non-retryable
  // answer: a 403, a 429, a SyntaxError off a malformed body. By then
  // retryFetch's `finally` has cleared the progress box, so LoadingState would
  // gate its "Retry now" button off and spin under "Taking longer than usual…"
  // indefinitely, with no copy and no way out. Say what happened and offer an
  // action instead. Reload rather than revalidate: /auth/me is fetched by
  // AuthProvider, not by a route loader, so there is nothing to revalidate.
  //
  // Card language deliberately borrowed from RootErrorBoundary — same situation
  // (a terminal failure with one recovery button), so it should look the same.
  if (authError) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // 100dvh, not 100vh: this renders outside .app-layout, where 100vh
        // overshoots the mobile visual viewport and scrolls the document. Same
        // reasoning as LoadingState's `full` variant, which this replaces here.
        minHeight: '100dvh', background: color.surfaceMuted,
      }}>
        <div style={{ textAlign: 'center', maxWidth: 420, padding: 32 }}>
          <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 8 }}>
            Something went wrong
          </h1>
          <p style={{ color: color.textMuted, fontSize: fontSize.base, marginBottom: 24 }}>
            We could not verify your session.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px',
              background: color.linkBlue,
              color: color.white,
              border: 'none',
              borderRadius: radius.md,
              fontSize: fontSize.sm,
              fontWeight: fontWeight.semibold,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}
