import React, { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch, ApiError } from '../lib/api'
import { Wordmark } from '../components/Wordmark'
import { usePageTitle } from '../hooks/usePageTitle'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'

// The page an email-change confirmation link opens (/auth/confirm-email), and
// the page "This wasn't me" in the old-address notices opens (/auth/not-me).
// Neither needs a session: the new inbox may be read on any device.
//
// The token is read from the URL once, kept in memory, and then removed from
// the address bar, so it does not linger in history or a copied address. The
// status call carries it in a POST body for the same reason: a GET query lands
// in access logs.
//
// Loading the confirmation page only reads the link's status. Mail scanners
// prefetch links, so the change happens only when someone presses the button.
// Confirming never signs anyone in.

const LINK_ERRORS = {
  expired: 'This link has expired. Request the change again from your Account page.',
  invalid: 'This link is no longer valid. It may have been used already, or replaced by a newer request.',
} as const

// When an admin asked for the change (#416) there is no Account page to go back
// to and request it again: the member may be signed out, and the admin asked.
const ADMIN_LINK_ERRORS = {
  expired: 'This link has expired. Ask the admin who requested the change to request it again.',
  invalid: LINK_ERRORS.invalid,
} as const

const NOT_ME_ERRORS = {
  expired: 'This link has expired.',
  invalid: 'This link is no longer valid. It may have been used already.',
} as const

type Status = { status: 'valid'; email: string; byAdmin?: boolean } | { status: 'expired'; byAdmin?: boolean } | { status: 'invalid' }

/**
 * Send no referrer from this page. The token is in its URL, so a Referer on
 * any request the page makes would carry it. The static _headers file sets the
 * same policy as a response header; this covers a host that doesn't apply it.
 */
function useNoReferrer() {
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'referrer'
    meta.content = 'no-referrer'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
}

export function ConfirmEmailChange() {
  usePageTitle('Confirm New Email')
  useNoReferrer()
  const [searchParams] = useSearchParams()
  // Held in state: the address bar loses it below, but the confirm still needs it.
  const [token] = useState(() => searchParams.get('token') ?? '')
  const [status, setStatus] = useState<Status | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ email: string; byAdmin: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Whether an admin asked, as far as the status call said (it may not have been made).
  const byAdmin = !!status && status.status !== 'invalid' && status.byAdmin === true

  useEffect(() => {
    if (!token) { setStatus({ status: 'invalid' }); return }
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash)
    let cancelled = false
    apiFetch<Status>('/auth/email-change/status', { method: 'POST', body: JSON.stringify({ token }) })
      .then((s) => { if (!cancelled) setStatus(s) })
      // Can't tell: offer the button, and let the confirm say what's wrong.
      .catch(() => { if (!cancelled) setStatus(null) })
    return () => { cancelled = true }
  }, [token])

  async function handleConfirm(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const r = await apiFetch<{ ok: true; email: string; byAdmin?: boolean }>('/auth/email-change/confirm', {
        method: 'POST',
        body: JSON.stringify({ token }),
      })
      setDone({ email: r.email, byAdmin: r.byAdmin === true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <Card title="Email Changed">
        <p style={styles.body}>Your sign-in email is now <strong>{done.email}</strong>.</p>
        {done.byAdmin
          ? (
            <>
              <p style={styles.body}>Everyone signed in to your account was signed out, including you. Sign in again with the new address.</p>
              <a href="/login" className="blue-link" style={styles.link}>Sign in</a>
            </>
          )
          : (
            <>
              <p style={styles.body}>Use it the next time you sign in.</p>
              <a href="/" className="blue-link" style={styles.link}>Go to {PRODUCT_NAME}</a>
            </>
          )}
      </Card>
    )
  }

  if (error) {
    return (
      <Card title="Email Not Changed">
        <p style={styles.error}>{error}</p>
        {byAdmin
          ? <a href="/" className="blue-link" style={styles.link}>Go to {PRODUCT_NAME}</a>
          : <a href="/profile" className="blue-link" style={styles.link}>Go to your Account page</a>}
      </Card>
    )
  }

  if (status && status.status !== 'valid') {
    return (
      <Card title={status.status === 'expired' ? 'Link Expired' : 'Link No Longer Valid'}>
        <p style={styles.error}>{(byAdmin ? ADMIN_LINK_ERRORS : LINK_ERRORS)[status.status]}</p>
        {byAdmin
          ? <a href="/" className="blue-link" style={styles.link}>Go to {PRODUCT_NAME}</a>
          : <a href="/profile" className="blue-link" style={styles.link}>Go to your Account page</a>}
      </Card>
    )
  }

  return (
    <Card title="Confirm Your New Email">
      <p style={styles.body}>
        {status
          ? <>{byAdmin ? 'An admin asked to make' : 'Make'} <strong>{status.email}</strong> the sign-in email for your {PRODUCT_NAME} account{byAdmin ? '. Confirm the change?' : '?'}</>
          : `Make this address the sign-in email for your ${PRODUCT_NAME} account?`}
      </p>
      <p style={styles.body}>
        Your old address stops working for sign-in as soon as you confirm.
        {byAdmin && ' You will be signed out everywhere, and sign in again with the new address.'}
      </p>
      <form onSubmit={handleConfirm}>
        <button type="submit" disabled={submitting} style={{ ...styles.button, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Confirming…' : 'Confirm new email'}
        </button>
      </form>
    </Card>
  )
}

type NotMeStatus = { status: 'valid' | 'expired' | 'invalid' }

/**
 * Where "This wasn't me" leads from an old-address notice. Built like the
 * confirmation page: the token is read once and taken out of the address bar,
 * loading the page only asks whether the link is still good, and the button
 * does the work. Pressing it signs the member out everywhere, cancels a
 * pending change the member started, and emails the instance's owners and admins. It never undoes
 * a change that has taken effect.
 */
export function EmailChangeNotMe() {
  usePageTitle("Didn't Ask for This Change?")
  useNoReferrer()
  const [searchParams] = useSearchParams()
  const [token] = useState(() => searchParams.get('token') ?? '')
  const [status, setStatus] = useState<NotMeStatus | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ alerted: boolean; cancelled: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) { setStatus({ status: 'invalid' }); return }
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash)
    let cancelled = false
    apiFetch<NotMeStatus>('/auth/email-change/not-me/status', { method: 'POST', body: JSON.stringify({ token }) })
      .then((s) => { if (!cancelled) setStatus(s) })
      // Can't tell: offer the button, and let the press say what's wrong.
      .catch(() => { if (!cancelled) setStatus(null) })
    return () => { cancelled = true }
  }, [token])

  async function handlePress(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      setDone(await apiFetch<{ ok: true; alerted: boolean; cancelled: boolean }>('/auth/email-change/not-me', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <Card title="You're Signed Out Everywhere">
        <p style={styles.body}>
          {done.alerted
            ? `We emailed your ${PRODUCT_NAME} admins so they can look into it.`
            : `We couldn't email your ${PRODUCT_NAME} admins. Please contact one of them directly.`}
        </p>
        <p style={styles.body}>
          {done.cancelled && <>A change you asked for that hadn&apos;t been confirmed was cancelled. </>}A change that already took effect isn&apos;t undone, but an admin can restore your address.
        </p>
        <a href="/login" className="blue-link" style={styles.link}>Sign in</a>
      </Card>
    )
  }

  if (error) {
    return (
      <Card title="Nothing Changed">
        <p style={styles.error}>{error}</p>
        <p style={styles.body}>If your sign-in email was changed and you didn&apos;t ask for it, contact one of your {PRODUCT_NAME} admins.</p>
      </Card>
    )
  }

  if (status && status.status !== 'valid') {
    return (
      <Card title={status.status === 'expired' ? 'Link Expired' : 'Link No Longer Valid'}>
        <p style={styles.error}>{NOT_ME_ERRORS[status.status]}</p>
        <p style={styles.body}>If your sign-in email was changed and you didn&apos;t ask for it, contact one of your {PRODUCT_NAME} admins.</p>
      </Card>
    )
  }

  return (
    <Card title="Didn't Ask for This Change?">
      <p style={styles.body}>
        Someone asked to change the sign-in email for your {PRODUCT_NAME} account. If that wasn&apos;t you, press the
        button. It signs you out everywhere and emails your admins so they can look into it.
      </p>
      <p style={styles.body}>If a change you asked for hasn&apos;t been confirmed yet, it cancels that change, but it doesn&apos;t undo one that has. If you did ask for it, you can close this page.</p>
      <form onSubmit={handlePress}>
        <button type="submit" disabled={submitting} style={{ ...styles.button, opacity: submitting ? 0.7 : 1 }}>
          {submitting ? 'Working…' : "This wasn't me"}
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
    overflowWrap: 'anywhere',
  },
  heading: { fontSize: fontSize.xxxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 12 },
  body: { fontSize: fontSize.base, color: color.textSlate500, marginBottom: 16, lineHeight: 1.5 },
  error: { fontSize: fontSize.base, color: color.textErrorRed, marginBottom: 16, lineHeight: 1.5 },
  link: { fontSize: fontSize.sm },
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
  },
} satisfies Record<string, React.CSSProperties>
