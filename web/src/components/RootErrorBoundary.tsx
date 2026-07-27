import { useRouteError, Navigate, Link } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

export function RootErrorBoundary() {
  const error = useRouteError()

  if (error instanceof ApiError && error.status === 401) {
    return <Navigate to="/login" replace />
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: color.surfaceMuted }}>
      <div style={{ textAlign: 'center', maxWidth: 420, padding: 32 }}>
        <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ color: color.textMuted, fontSize: fontSize.base, marginBottom: 24 }}>
          An unexpected error occurred. Try reloading the page or signing in again.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button
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
            Reload page
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
