import React, { useState, type FormEvent } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { apiFetch, ApiError } from '../lib/api'
import { Wordmark as BrandWordmark } from '../components/Wordmark'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'

const VERIFY_ERRORS: Record<string, string> = {
  expired: 'This link has expired. Request a new one.',
  used: 'This link has already been used. Request a new one.',
  invalid: 'This link is invalid. Request a new one.',
  'token is required': 'This link is invalid. Request a new one.',
}

export function AuthVerify() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!token) return <Navigate to="/login" replace />

  async function handleSignIn(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await apiFetch('/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      })
      window.location.replace('/')
    } catch (err) {
      const key = err instanceof ApiError ? err.message : 'invalid'
      setError(VERIFY_ERRORS[key] ?? VERIFY_ERRORS.invalid)
      setLoading(false)
    }
  }

  if (error) {
    return (
      <div style={styles.container}>
        <Wordmark />
        <div style={styles.card}>
          <p style={styles.error}>{error}</p>
          <a href="/login" className="blue-link" style={styles.back}>← Back to sign in</a>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <Wordmark />
      <div style={styles.card}>
        <h1 style={styles.heading}>Sign in to {PRODUCT_NAME}</h1>
        <p style={styles.body}>Click below to complete your sign-in.</p>
        <form onSubmit={handleSignIn}>
          <button
            type="submit"
            disabled={loading}
            style={{ ...styles.button, opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}

function Wordmark() {
  return (
    <div style={{ marginBottom: 24 }}>
      <BrandWordmark />
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    background: color.bgLoginPage,
    fontFamily: 'system-ui, sans-serif',
  } as React.CSSProperties,
  card: {
    background: color.white,
    border: `1px solid ${color.borderDefault}`,
    borderRadius: radius.xl,
    padding: '40px 48px',
    width: 360,
    boxShadow: shadow.sm,
  } as React.CSSProperties,
  heading: { fontSize: fontSize.xxxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 8 } as React.CSSProperties,
  body: { fontSize: fontSize.base, color: color.textSlate500, marginBottom: 20 } as React.CSSProperties,
  button: {
    width: '100%',
    background: color.billBadgeNavy,
    color: color.white,
    border: 'none',
    borderRadius: radius.md,
    padding: '10px 0',
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    cursor: 'pointer',
  } as React.CSSProperties,
  error: { fontSize: fontSize.sm, color: color.textErrorRed, marginBottom: 12 } as React.CSSProperties,
  back: { fontSize: fontSize.sm } as React.CSSProperties,
}
