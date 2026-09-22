import React, { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
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

type LinkStatus = { status: 'valid' | 'used' | 'expired' | 'invalid'; email?: string }

export function AuthVerify() {
  const { user, loading: authLoading } = useAuth()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(null)
  const [statusSettled, setStatusSettled] = useState(false)

  // What this link's fate is, without spending it. The button below exists to
  // stop mail scanners consuming a live link, and a scanner carries no session
  // -- so for a visitor the app already recognises it defends nothing. Knowing
  // the status up front is what lets us skip it for them.
  useEffect(() => {
    if (!token) { setStatusSettled(true); return }
    let cancelled = false
    apiFetch<LinkStatus>(`/auth/verify/status?token=${encodeURIComponent(token)}`)
      .then((s) => { if (!cancelled) setLinkStatus(s) })
      // Falling back to the button is the whole failure plan: this endpoint is
      // an optimisation over a flow that already works, and must never be the
      // reason somebody cannot sign in.
      .catch(() => { if (!cancelled) setLinkStatus(null) })
      .finally(() => { if (!cancelled) setStatusSettled(true) })
    return () => { cancelled = true }
  }, [token])

  const submit = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await apiFetch('/auth/verify', { method: 'POST', body: JSON.stringify({ token }) })
      window.location.replace('/')
    } catch (err) {
      const key = err instanceof ApiError ? err.message : 'invalid'
      // Already signed in, and the link turned out to be spent after all -- the
      // owner used it between our status check and this POST. Same destination
      // as the status path would have chosen.
      if (user && (key === 'used' || key === 'expired')) {
        window.location.replace('/')
        return
      }
      setError(VERIFY_ERRORS[key] ?? VERIFY_ERRORS.invalid)
      setLoading(false)
    }
  }, [token, user])

  const sameAccount =
    !!user?.email && !!linkStatus?.email &&
    user.email.toLowerCase() === linkStatus.email.toLowerCase()

  useEffect(() => {
    // Nothing is known until BOTH answers land. Acting early would flash the
    // button at someone who should never see it, or act as the wrong user.
    if (authLoading || !statusSettled || !user || !linkStatus) return
    if (linkStatus.status === 'used' || linkStatus.status === 'expired') {
      window.location.replace('/')   // nothing left to consume
      return
    }
    if (linkStatus.status === 'valid' && sameAccount) {
      void submit()                  // consume it on the way past
    }
    // 'valid' for someone else falls through to the confirmation below.
    // 'invalid' falls through to the button, which will say so.
  }, [authLoading, statusSettled, user, linkStatus, sameAccount, submit])

  async function handleSignIn(e: FormEvent) {
    e.preventDefault()
    await submit()
  }

  if (!token) return <Navigate to="/login" replace />

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

  // The one case that needs a person: signed in as one account, holding a live
  // link for another. Both addresses are named in full, and the signed-in one
  // is never rendered as "you" -- somebody with two accounts, or on a shared
  // machine, may not know which one the browser is holding, and that is exactly
  // the reader this screen exists for.
  if (user && linkStatus?.status === 'valid' && !sameAccount) {
    return (
      <div style={styles.container}>
        <Wordmark />
        <div style={styles.card}>
          <h1 style={styles.heading}>You are signed in as {user.email}</h1>
          <p style={styles.body}>
            This sign-in link is for <strong>{linkStatus.email}</strong>. Continuing will
            sign you out of {user.email} and sign you in as {linkStatus.email}.
          </p>
          <button type="button" disabled={loading} style={styles.button} onClick={() => void submit()}>
            Continue as {linkStatus.email}
          </button>
          <button type="button" style={styles.secondaryButton} onClick={() => window.location.replace('/')}>
            Stay signed in as {user.email}
          </button>
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
  secondaryButton: {
    width: '100%',
    marginTop: 8,
    background: 'none',
    color: color.textMuted,
    border: `1px solid ${color.borderDefault}`,
    borderRadius: radius.md,
    padding: '10px 0',
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    cursor: 'pointer',
  } as React.CSSProperties,
  error: { fontSize: fontSize.sm, color: color.textErrorRed, marginBottom: 12 } as React.CSSProperties,
  back: { fontSize: fontSize.sm } as React.CSSProperties,
}
