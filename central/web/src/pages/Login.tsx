import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { Turnstile } from '../components/Turnstile'

export default function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [widgetKey, setWidgetKey] = useState(0) // bump to remount for a fresh single-use token
  // Public Turnstile sitekey, served by /admin/dash/auth/config. Empty = no widget
  // (fail-open, mirrors the server gate). null until the bootstrap fetch resolves.
  const [siteKey, setSiteKey] = useState<string | null>(null)
  const [bootstrapped, setBootstrapped] = useState(false)

  useEffect(() => {
    api<{ turnstileSiteKey: string }>('/admin/dash/auth/config')
      .then(r => setSiteKey(r.turnstileSiteKey ?? ''))
      .catch(() => setSiteKey(''))
      .finally(() => setBootstrapped(true))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      await api('/admin/dash/auth/login', { method: 'POST', body: JSON.stringify({ email, turnstileToken: token }) })
      setSent(true)
    } catch (e: any) {
      setErr(e.message ?? 'Failed to send link')
      setToken(null)
      setWidgetKey(k => k + 1)
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '120px auto', padding: 24, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }}>
      <h1 style={{ marginTop: 0, fontSize: 22 }}>Sign in to Central Admin</h1>
      {sent ? (
        <p style={{ color: 'var(--muted)' }}>Check your inbox — if your email is authorized, a sign-in link is on its way.</p>
      ) : (
        <form onSubmit={submit}>
          <label style={{ display: 'block', fontSize: 14, marginBottom: 6 }}>Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid var(--border)', borderRadius: 6 }}
          />
          {err && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</p>}
          {siteKey ? (
            <div style={{ marginTop: 16 }}>
              <Turnstile key={widgetKey} sitekey={siteKey} onToken={setToken} />
            </div>
          ) : null}
          {(() => {
            // Gate submit on a solved token only when Turnstile is configured; stay
            // disabled until the bootstrap fetch resolves so we never allow a
            // tokenless submit the server would 403.
            const needsToken = !!siteKey
            const ready = bootstrapped && (!needsToken || !!token)
            return (
              <button
                type="submit"
                disabled={!ready}
                style={{ marginTop: 16, width: '100%', padding: '10px 12px', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, fontWeight: 600, cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.6 }}
              >
                Send sign-in link
              </button>
            )
          })()}
        </form>
      )}
    </div>
  )
}
