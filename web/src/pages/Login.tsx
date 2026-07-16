import React, { useState, useEffect, type FormEvent } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { Wordmark as BrandWordmark } from '../components/Wordmark'
import { Turnstile } from '../components/Turnstile'
import { usePageTitle } from '../hooks/usePageTitle'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'
import { hasTerms, hasPrivacy } from '../lib/legalDocs'

const AUTH_ERRORS: Record<string, string> = {
  expired: 'This link has expired. Request a new one.',
  used: 'This link has already been used. Request a new one.',
  invalid: 'This link is invalid. Request a new one.',
}

export function Login() {
  usePageTitle('Sign In')
  const [searchParams] = useSearchParams()
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [turnstileKey, setTurnstileKey] = useState(0) // bump to remount widget for a fresh (single-use) token
  // Public Turnstile sitekey, served by /auth/demo-mode. Empty/null = no widget
  // (fail-open, mirrors the server gate) so a self-hoster who hasn't configured
  // Turnstile still gets a working login. null until the bootstrap fetch resolves.
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null)
  const [bootstrapped, setBootstrapped] = useState(false)
  const [demoMode, setDemoMode] = useState(false)
  const [demoAutoLogging, setDemoAutoLogging] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(
    AUTH_ERRORS[searchParams.get('error') ?? ''] ?? null,
  )
  const isManual = searchParams.get('manual') === '1'

  useEffect(() => {
    apiFetch<{ demoMode: boolean; turnstileSiteKey?: string }>('/auth/demo-mode')
      .then((r) => {
        setDemoMode(r.demoMode)
        setTurnstileSiteKey(r.turnstileSiteKey ?? '')
        if (r.demoMode && !isManual) {
          setDemoAutoLogging(true)
          apiFetch('/auth/demo-login', { method: 'POST' })
            .then(() => { window.location.href = '/' })
            .catch(() => { setDemoAutoLogging(false) })
        }
      })
      .catch(() => {})
      .finally(() => setBootstrapped(true))
  }, [isManual])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setSubmitting(true)
    try {
      await apiFetch('/auth/magic-link', {
        method: 'POST',
        body: JSON.stringify({ email, turnstileToken }),
      })
      setSubmitted(true)
    } catch {
      setError('Something went wrong. Please try again.')
      // Turnstile tokens are single-use — remount the widget for a fresh one on retry.
      setTurnstileToken(null)
      setTurnstileKey((k) => k + 1)
      setSubmitting(false)
    }
  }

  async function handleDemoLogin() {
    setDemoLoading(true)
    setError(null)
    try {
      await apiFetch('/auth/demo-login', { method: 'POST' })
      window.location.href = '/'
    } catch {
      setError('Demo login failed. Please try again.')
      setDemoLoading(false)
    }
  }

  if (demoAutoLogging) {
    return (
      <div style={styles.container}>
        <Wordmark />
        <div style={{ ...styles.card, textAlign: 'center' as const }}>
          <p style={{ ...styles.body, marginBottom: 0, color: color.textSecondary }}>Loading demo…</p>
        </div>
      </div>
    )
  }

  if (submitted) {
    return (
      <div style={styles.container}>
        <Wordmark />
        <div style={styles.card}>
          <h1 style={styles.heading}>Check your email</h1>
          <p style={styles.body}>
            If <strong>{email}</strong> is registered, you'll receive a sign-in link shortly. The link expires in 30 minutes.
          </p>
          <p style={{ ...styles.body, marginTop: 12, color: color.textMuted, fontSize: fontSize.sm }}>
            If you don't receive it within a minute or two, check your spam folder. Also, make sure this address matches the one on your account or invitation.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <Wordmark />
      <div style={styles.card}>
        <h1 style={styles.heading}>Sign in</h1>
        <p style={styles.body}>Enter your email to receive a sign-in link.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="email" style={{ display: 'block', fontSize: fontSize.base, color: color.textSlate, marginBottom: 6 }}>
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={styles.input}
          />
          {error && <p style={styles.error}>{error}</p>}
          {turnstileSiteKey ? (
            <Turnstile key={turnstileKey} sitekey={turnstileSiteKey} onToken={setTurnstileToken} />
          ) : null}
          {(() => {
            // Gate submit on a solved token only when Turnstile is configured. Stay
            // disabled until the bootstrap fetch resolves so we don't briefly allow
            // a tokenless submit that the server would 403.
            const needsToken = !!turnstileSiteKey
            const ready = bootstrapped && (!needsToken || !!turnstileToken)
            const enabled = ready && !submitting
            return (
              <button
                type="submit"
                disabled={!enabled}
                style={{ ...styles.button, opacity: enabled ? 1 : 0.6, cursor: enabled ? 'pointer' : 'not-allowed' }}
              >
                {submitting ? 'Sending…' : 'Send sign-in link'}
              </button>
            )
          })()}
        </form>
        {demoMode && (
          <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${color.borderDefault}` }}>
            <p style={{ ...styles.body, marginBottom: 12, textAlign: 'center' as const }}>
              Want to explore first?
            </p>
            <button
              onClick={handleDemoLogin}
              disabled={demoLoading}
              style={{
                ...styles.button,
                background: color.white,
                color: color.billBadgeNavy,
                border: `1.5px solid ${color.billBadgeNavy}`,
                opacity: demoLoading ? 0.6 : 1,
                cursor: demoLoading ? 'not-allowed' : 'pointer',
              }}
            >
              {demoLoading ? 'Loading…' : 'Try the demo'}
            </button>
          </div>
        )}
      </div>
      <LegalLinks />
    </div>
  )
}

function Wordmark() {
  return (
    <div style={{ marginBottom: 24 }}>
      <BrandWordmark size={fontSize.xxxl} />
    </div>
  )
}

function LegalLinks() {
  if (!hasTerms && !hasPrivacy) return null
  return (
    <div style={{ marginTop: 20, fontSize: fontSize.sm, color: color.textMuted }}>
      {hasTerms && <Link to="/terms" style={{ color: color.textMuted }}>Terms of Use</Link>}
      {hasTerms && hasPrivacy && ' · '}
      {hasPrivacy && <Link to="/privacy" style={{ color: color.textMuted }}>Privacy Policy</Link>}
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
    // 420 (border-box) → 324px content, above the Turnstile widget's 300px
    // flexible minimum so the widget, email box, and button align in width.
    width: 420,
    boxShadow: shadow.sm,
  } as React.CSSProperties,
  heading: { fontSize: fontSize.xxxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 8 } as React.CSSProperties,
  body: { fontSize: fontSize.base, color: color.textSlate500, marginBottom: 20 } as React.CSSProperties,
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    border: `1px solid ${color.borderStrong}`,
    borderRadius: radius.md,
    padding: '9px 12px',
    fontSize: fontSize.base,
    marginBottom: 12,
    color: color.textPrimary,
  } as React.CSSProperties,
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
  error: { fontSize: fontSize.sm, color: color.textErrorRed, marginBottom: 8 } as React.CSSProperties,
}
