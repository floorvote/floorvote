import React, { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, ApiError } from '../lib/api'
import { Wordmark } from '../components/Wordmark'
import { usePageTitle } from '../hooks/usePageTitle'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'

// The page a reply email's "Mute this bill" footer link opens (/mute-bill,
// #355). It needs no session: the link carries a token signed for one member
// and one bill, and can mute only that bill for that member.
//
// Loading the page mutes nothing, since mail scanners follow links. The mute
// happens when someone presses the button. The token is read from the URL once,
// kept in memory, and removed from the address bar, and the page sends no
// referrer, so the token does not linger in history or leak to another site.

const NOT_VALID = 'This link is not valid.'

type Muted = { billNumber: string; billTitle: string; billPath: string }

/** Send no referrer from this page. The static _headers file sets the same policy. */
function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'referrer'
    meta.content = 'no-referrer'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
}

export function MuteBillLink() {
  usePageTitle('Mute Comments')
  useNoReferrer()
  const [searchParams] = useSearchParams()
  // Held in state: the address bar loses it below, but the mute still needs it.
  const [token] = useState(() => searchParams.get('token') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [muted, setMuted] = useState<Muted | null>(null)
  const [error, setError] = useState<string | null>(token ? null : NOT_VALID)

  useEffect(() => {
    if (token) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash)
  }, [token])

  async function handleMute(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      setMuted(await apiFetch<Muted>('/mute-link', { method: 'POST', body: JSON.stringify({ token }) }))
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? NOT_VALID : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (muted) {
    return (
      <Card title="Comments Muted">
        <p style={styles.body}>
          You won't be notified of new comments on <strong>{muted.billNumber}</strong>. Mentions still reach you.
        </p>
        <p style={styles.body}>To unmute, open the bill and select “Unmute comments.”</p>
        <a href={muted.billPath} className="blue-link" style={styles.link}>Open the bill</a>
      </Card>
    )
  }

  if (error === NOT_VALID) {
    return (
      <Card title="Link Not Valid">
        <p style={styles.error}>{NOT_VALID}</p>
        <p style={styles.body}>You can mute a bill's comments from its page in {PRODUCT_NAME}.</p>
        <a href="/" className="blue-link" style={styles.link}>Go to {PRODUCT_NAME}</a>
      </Card>
    )
  }

  return (
    <Card title="Mute Comments on This Bill?">
      <p style={styles.body}>
        You'll stop getting notifications and emails about new comments on this bill. Mentions still reach you.
      </p>
      <form onSubmit={handleMute}>
        {error && <p style={styles.error}>{error}</p>}
        <button type="submit" disabled={submitting} style={{ ...styles.button, opacity: submitting ? 0.6 : 1 }}>
          Mute comments
        </button>
      </form>
    </Card>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={styles.container}>
      <div style={{ marginBottom: 24 }}><Wordmark /></div>
      <div style={styles.card}>
        <h1 style={styles.heading}>{title}</h1>
        {children}
      </div>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: color.bgLoginPage,
    fontFamily: 'system-ui, sans-serif',
    padding: '24px 16px',
    boxSizing: 'border-box',
  },
  card: {
    background: color.white,
    border: `1px solid ${color.borderDefault}`,
    borderRadius: radius.xl,
    padding: 'clamp(24px, 6vw, 40px) clamp(20px, 6vw, 48px)',
    width: '100%',
    maxWidth: 400,
    boxSizing: 'border-box',
    boxShadow: shadow.sm,
  },
  heading: { fontSize: fontSize.xxxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginTop: 0, marginBottom: 8 },
  body: { fontSize: fontSize.base, color: color.textSlate500, marginBottom: 16 },
  button: {
    width: '100%',
    background: color.billBadgeNavy,
    color: color.textOnFill,
    border: 'none',
    borderRadius: radius.md,
    padding: '10px 0',
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    cursor: 'pointer',
  },
  error: { fontSize: fontSize.sm, color: color.textErrorRed, marginBottom: 12 },
  link: { fontSize: fontSize.sm },
} satisfies Record<string, React.CSSProperties>
