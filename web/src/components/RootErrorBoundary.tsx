import { useEffect, useRef } from 'react'
import { useRouteError, useRevalidator, Navigate, Link } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

export function RootErrorBoundary() {
  const error = useRouteError()
  const revalidator = useRevalidator()
  // Whether a revalidation actually got underway since the last "Try again".
  const startedRef = useRef(false)
  const mountedRef = useRef(true)

  // Set on mount as well as cleared on unmount: StrictMode (see main.tsx) mounts,
  // unmounts, and remounts, and a cleanup-only ref would stay false forever.
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (revalidator.state !== 'idle') startedRef.current = true
  }, [revalidator.state])

  // "Try again" prefers revalidation — re-running the failed loader tears this
  // boundary down in place, no reload. But revalidate() is a silent no-op when no
  // matched route has a loader (/profile, every /admin/*), and an error on those
  // routes is by definition a render-time throw: exactly the case a reload can fix
  // and a revalidation cannot. Falling back keeps the button live everywhere.
  //
  // Detected by watching revalidator.state leave 'idle', not by inspecting the
  // matches: loader presence is invisible to every public hook (useMatches()
  // exposes `data`, equally undefined for a loader-less route and for one whose
  // loader just threw), and the alternative is reaching into
  // UNSAFE_DataRouterStateContext.
  //
  // The decision has to happen on the revalidate() promise, not in an effect.
  // React does NOT batch this state update with the router's: a click flushes one
  // render still reading 'idle' before the 'loading' render arrives, so an effect
  // would see 'idle' and reload every time. Measured ordering for a route that
  // does revalidate — even with a synchronous loader — is loading-render →
  // loading-effect → promise, so startedRef is settled by the time this runs.
  const tryAgain = () => {
    startedRef.current = false
    void revalidator.revalidate().then(() => {
      if (mountedRef.current && !startedRef.current) window.location.reload()
    })
  }

  if (error instanceof ApiError && error.status === 401) {
    return <Navigate to="/login" replace />
  }

  // A thrown redirect Response reaching an error boundary means it came from a
  // render rather than a loader (see FeedPane's slow path). Honor it rather than
  // showing an error card for what is really a session expiry.
  //
  // Only a render-thrown Response is still a Response here: RR wraps a
  // loader-thrown one in an ErrorResponse, so billDetailLoader's 409/500 throws
  // fail this check and keep hitting the card.
  //
  // Disjoint from the 401 branch above — an ApiError is never a Response — so
  // the two are order-independent and no ordering test could ever fail.
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return <Navigate to={error.headers.get('Location') ?? '/login'} replace />
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: color.surfaceMuted }}>
      <div style={{ textAlign: 'center', maxWidth: 420, padding: 32 }}>
        <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ color: color.textMuted, fontSize: fontSize.base, marginBottom: 24 }}>
          The page could not be loaded.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
            onClick={tryAgain}
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
          <Link
            to="/login"
            style={{
              padding: '8px 20px',
              background: color.white,
              color: color.linkBlue,
              border: `1px solid ${color.borderDefault}`,
              borderRadius: radius.md,
              fontSize: fontSize.sm,
              fontWeight: fontWeight.semibold,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  )
}
