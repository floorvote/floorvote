import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useDemo } from '../context/DemoContext'
import { legalDocsVisible } from '../lib/legalVisibility'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

// Copy per case. An existing member reaching this on the initial rollout may
// have been here for years, so `existing_member` is deliberately neutral --
// welcome framing would greet them as a newcomer.
const COPY = {
  first_login: `Welcome to ${PRODUCT_NAME}. Before you get started, please review our Terms of Use and Privacy Policy.`,
  existing_member: 'Before you continue, please review our Terms of Use and Privacy Policy.',
  update: "We've updated our Terms of Use and Privacy Policy since you last accepted them.",
} as const

const HEADING = {
  first_login: `Welcome to ${PRODUCT_NAME}`,
  existing_member: 'Our legal terms',
  update: 'Our legal terms have changed',
} as const

/**
 * The clickwrap interstitial. Rendered by RequireAuth in place of the routed
 * content, so it cannot be navigated past.
 *
 * Card language is borrowed from RequireAuth's authError branch and
 * RootErrorBoundary: a full-screen stop with one action, so it should look like
 * the others.
 */
export function AcceptTerms() {
  const { user, setTermsAccepted } = useAuth()
  const { demoMode } = useDemo()
  const { showTerms, showPrivacy } = legalDocsVisible(!!demoMode)
  const navigate = useNavigate()
  const [checked, setChecked] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)

  const kind = user?.termsAcceptanceKind ?? 'existing_member'

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
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // 100dvh, not 100vh: this renders outside .app-layout, where 100vh
      // overshoots the mobile visual viewport and scrolls the document.
      minHeight: '100dvh', background: color.surfaceMuted,
    }}>
      <div style={{ maxWidth: 460, padding: 32 }}>
        <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 8 }}>
          {HEADING[kind]}
        </h1>
        <p style={{ color: color.textMuted, fontSize: fontSize.base, marginBottom: 20 }}>
          {COPY[kind]}
        </p>

        {/* target="_blank" is load-bearing: a same-tab navigation would unmount
            this component and discard the checkbox state. */}
        <p style={{ fontSize: fontSize.sm, marginBottom: 20 }}>
          {showTerms && (
            <Link to="/terms" target="_blank" rel="noopener noreferrer" style={{ color: color.linkBlue }}>
              Terms of Use
            </Link>
          )}
          {showTerms && showPrivacy && <span style={{ color: color.textMuted }}> · </span>}
          {showPrivacy && (
            <Link to="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: color.linkBlue }}>
              Privacy Policy
            </Link>
          )}
        </p>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, fontSize: fontSize.sm, color: color.textPrimary, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => { setChecked(e.target.checked); if (e.target.checked) setBlocked(false) }}
            style={{ marginTop: 2, cursor: 'pointer' }}
          />
          <span>I have read and agree to the Terms of Use and Privacy Policy.</span>
        </label>

        {blocked && (
          <p role="alert" style={{ color: color.textDanger, fontSize: fontSize.sm, marginBottom: 12 }}>
            Please confirm you agree to continue.
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
          <button
            type="button"
            onClick={handleContinue}
            disabled={busy}
            style={{
              padding: '8px 20px', background: color.linkBlue, color: color.white,
              border: 'none', borderRadius: radius.md, fontSize: fontSize.sm,
              fontWeight: fontWeight.semibold, cursor: busy ? 'wait' : 'pointer',
            }}
          >
            Continue
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            style={{
              background: 'none', border: 'none', padding: 0, color: color.textMuted,
              fontSize: fontSize.sm, textDecoration: 'underline', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
