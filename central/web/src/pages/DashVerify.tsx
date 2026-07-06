import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../lib/api'

// Two-step magic-link interstitial (scanner pre-fetch protection). The emailed
// link is a GET that only redirects here; this page POSTs to consume the token,
// so an email security appliance that pre-fetches the link can't burn it — the
// human still has to land here and click. Mirrors the tenant /auth/verify page.
export default function DashVerify() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      await api('/admin/dash/auth/callback', { method: 'POST', body: JSON.stringify({ token }) })
      window.location.replace('/')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'This link is invalid or has expired. Request a new one.')
      setLoading(false)
    }
  }

  const card = { maxWidth: 360, margin: '120px auto', padding: 24, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 } as const

  if (!token) {
    return (
      <div style={card}>
        <p style={{ color: 'var(--danger)', fontSize: 13 }}>Missing sign-in token.</p>
        <a href="/" style={{ color: 'var(--accent)', fontSize: 14 }}>← Back to sign in</a>
      </div>
    )
  }

  return (
    <div style={card}>
      <h1 style={{ marginTop: 0, fontSize: 22 }}>Sign in to Central Admin</h1>
      {error ? (
        <>
          <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p>
          <a href="/" style={{ color: 'var(--accent)', fontSize: 14 }}>← Back to sign in</a>
        </>
      ) : (
        <>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Click below to complete your sign-in.</p>
          <button
            type="button"
            onClick={signIn}
            disabled={loading}
            style={{ marginTop: 8, width: '100%', padding: '10px 12px', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </>
      )}
    </div>
  )
}
