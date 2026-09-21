import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useDemo } from '../context/DemoContext'
import { legalDocsVisible } from '../lib/legalVisibility'
import { Wordmark } from './Wordmark'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, fontSize, fontWeight, radius, shadow } from '../styles/tokens'

/**
 * The clickwrap interstitial. Rendered by RequireAuth in place of the routed
 * content, so it cannot be navigated past.
 *
 * Built as a sibling of the login page, not of the error card: both are
 * full-screen gates standing between someone and the app, so this wears the same
 * wordmark-over-a-card furniture rather than looking like something broke.
 *
 * It cannot be a modal over the live app, tempting as that is. requireAuth
 * refuses every route but POST /auth/accept-terms while acceptance is
 * outstanding, so the "app" behind such a modal would be an empty sidebar and a
 * failed bill list -- and each failed call would re-fire the terms-not-accepted
 * event. Showing the product's own chrome instead is the honest version of the
 * same intent.
 *
 * The operator is not named here for the same reason: /config sits behind
 * requireAuth, so its name and logo are unreachable while the gate is up. The
 * login page has the same constraint and resolves it the same way. Both
 * documents name the operator in their opening paragraph, one click away.
 */
export function AcceptTerms({ onAccepted }: {
  /**
   * Called after a successful acceptance, in addition to clearing the flag.
   * RootErrorBoundary passes a revalidate here: when the interstitial is reached
   * because a loader threw, flipping the flag alone leaves the router parked in
   * its error state.
   */
  onAccepted?: () => void
} = {}) {
  const { user, setTermsAccepted } = useAuth()
  const { demoMode } = useDemo()
  const { showTerms, showPrivacy } = legalDocsVisible(!!demoMode)
  const navigate = useNavigate()
  const [checked, setChecked] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)

  const kind = user?.termsAcceptanceKind ?? 'existing_member'

  // Named once, linked at that first mention, and not repeated as a bare row of
  // links underneath -- three sightings of "Terms of Use and Privacy Policy" on
  // one short screen read as boilerplate rather than as something to read.
  const terms = showTerms
    ? <Link to="/terms" target="_blank" rel="noopener noreferrer" style={linkStyle}>Terms of Use</Link>
    : <>Terms of Use</>
  const privacy = showPrivacy
    ? <Link to="/privacy" target="_blank" rel="noopener noreferrer" style={linkStyle}>Privacy Policy</Link>
    : <>Privacy Policy</>
  const both: ReactNode = <>{terms} and {privacy}</>

  const HEADING = {
    first_login: `Welcome to ${PRODUCT_NAME}`,
    existing_member: 'Our legal terms',
    update: 'Our legal terms have changed',
  }[kind]

  const BODY: ReactNode = {
    // The spec's copy opened "Welcome to {PRODUCT_NAME}." again here. With the
    // wordmark above the card and the greeting in the heading, a third naming in
    // two lines reads as a mail merge.
    first_login: <>Before you get started, please review our {both}.</>,
    existing_member: <>Before you continue, please review our {both}.</>,
    update: <>We&rsquo;ve updated our {both} since you last accepted them.</>,
  }[kind]

  async function handleContinue() {
    // Naming the blocker rather than disabling the button: a disabled control
    // gives no feedback on tap, announces nothing about why it is inert, and
    // turns the checkbox into a puzzle. It is also better evidence that the
    // person was told what they were agreeing to.
    if (!checked) { setBlocked(true); return }
    setBusy(true)
    try {
      await apiFetch('/auth/accept-terms', { method: 'POST' })
      setTermsAccepted()
      onAccepted?.()
    } finally {
      setBusy(false)
    }
  }

  // No decline button. Refusing is simply leaving -- an explicit decline invites
  // "what happens to my data?", which this screen cannot honestly answer, since
  // only an admin can remove an account.
  async function handleSignOut() {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {})
    navigate('/login')
  }

  return (
    <div style={styles.container}>
      <div style={{ marginBottom: 24 }}>
        <Wordmark size={fontSize.xxxl} />
      </div>
      <div style={styles.card}>
        <h1 style={styles.heading}>{HEADING}</h1>
        <p style={styles.body}>{BODY}</p>

        <label style={styles.checkRow}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => { setChecked(e.target.checked); if (e.target.checked) setBlocked(false) }}
            style={{ marginTop: 2, cursor: 'pointer' }}
          />
          <span>I have read and agree to the {both}.</span>
        </label>

        {blocked && (
          <p role="alert" style={styles.error}>Please confirm you agree to continue.</p>
        )}

        <div style={styles.actions}>
          <button type="button" onClick={handleContinue} disabled={busy} style={{ ...styles.button, cursor: busy ? 'wait' : 'pointer' }}>
            Continue
          </button>
          <button type="button" onClick={handleSignOut} style={styles.signOut}>Sign out</button>
        </div>
      </div>
    </div>
  )
}

const linkStyle: React.CSSProperties = { color: color.linkBlue }

const styles = {
  container: {
    minHeight: '100dvh',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    background: color.bgLoginPage,
    padding: 16,
  } as React.CSSProperties,
  card: {
    background: color.white,
    border: `1px solid ${color.borderDefault}`,
    borderRadius: radius.xl,
    padding: '40px 48px',
    width: 420,
    maxWidth: '100%',
    boxSizing: 'border-box' as const,
    boxShadow: shadow.sm,
  } as React.CSSProperties,
  heading: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginTop: 0, marginBottom: 8 } as React.CSSProperties,
  body: { fontSize: fontSize.base, color: color.textSlate500, marginTop: 0, marginBottom: 20, lineHeight: 1.5 } as React.CSSProperties,
  checkRow: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: fontSize.sm, color: color.textPrimary, cursor: 'pointer', lineHeight: 1.5 } as React.CSSProperties,
  error: { fontSize: fontSize.sm, color: color.textErrorRed, marginBottom: 0, marginTop: 8 } as React.CSSProperties,
  actions: { display: 'flex', alignItems: 'center', gap: 16, marginTop: 20 } as React.CSSProperties,
  button: {
    background: color.billBadgeNavy, color: color.white, border: 'none',
    borderRadius: radius.md, padding: '10px 24px', fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
  } as React.CSSProperties,
  signOut: {
    background: 'none', border: 'none', padding: 0, color: color.textMuted,
    fontSize: fontSize.sm, textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit',
  } as React.CSSProperties,
}
