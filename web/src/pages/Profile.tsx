import { useState, useEffect, useRef, useReducer, useId } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useConfig } from '../context/ConfigContext'
import { SettingsNav } from '../components/SettingsNav'
import { apiFetch, ApiError } from '../lib/api'
import { CARD } from '../lib/cardStyle'
import { CARD_TITLE, FORM_LABEL, HELPER_TEXT } from '../lib/textStyles'
import { relativeTime, absoluteTime } from '../lib/time'
import { usePageTitle } from '../hooks/usePageTitle'
import { useDemo } from '../context/DemoContext'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { actionRowStyle, actionRowStyleFirst, actionBtnBlue, actionBtnRed } from '../styles/actionRow'
import { primaryButtonColors } from '../styles/primaryButton'
import { digestCadenceDescription, digestMatchesLabel, weekAheadCadenceDescription, isModuleEnabled } from '../lib/modules'
import type { ModulesConfig } from '../lib/modules'
import { DEFAULT_ORG_NOUN } from '../lib/orgNoun'
import { emailChangedLabel, ownEmailChangeLabel, type EmailChangeStepFields } from '../lib/emailChangedLabel'
import { getColorMode, setColorMode, type ColorMode } from '../lib/colorMode'
import { emailChangeReducer, IDLE as EMAIL_CHANGE_IDLE } from '../lib/emailChangeState'
import { EmailChangePill } from '../components/EmailChangePill'

const SECTION_CARD: React.CSSProperties = { ...CARD, padding: 24, marginBottom: 20 }

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

type AccountAuthEvent = EmailChangeStepFields & {
  id: string
  event: string
  linkType: string | null
  provider: string | null
  ipCountry: string | null
  createdAt: string
}

function accountEventLabel(e: AccountAuthEvent, selfId: string): string {
  const step = ownEmailChangeLabel(e, selfId)
  if (step) return step
  switch (e.event) {
    case 'link_requested':
      return e.linkType === 'invite' ? 'Invite sent' : 'Login link requested'
    case 'email_sent':
      return e.linkType === 'invite' ? 'Invite email sent' : 'Email sent'
    case 'email_bounced':
      return 'Email bounced'
    case 'email_send_failed':
      return e.reason ? `Email send failed (${e.reason})` : 'Email send failed'
    case 'verify_success':
      return 'Signed in'
    case 'verify_failed':
      return e.reason ? `Link failed (${e.reason})` : 'Link failed'
    case 'logout':
      return 'Logged out'
    case 'rate_limited':
      return 'Rate-limited (too many active links)'
    case 'email_delivered':
      return 'Email delivered'
    case 'email_complained':
      return 'Spam complaint'
    case 'email_changed':
      return emailChangedLabel(e)
    default:
      return e.event
  }
}

// Names only the mentions that can reach this member: everyone gets direct
// and @everyone mentions, a role member their role's, an Admin or Owner @admins.
function alwaysEmailedLine(isAdmin: boolean, roleCount: number): string {
  const kinds = ['you']
  if (roleCount === 1) kinds.push('your role')
  if (roleCount > 1) kinds.push('one of your roles')
  if (isAdmin) kinds.push('@admins')
  kinds.push('@everyone')
  const list = kinds.length === 2 ? kinds.join(' or ') : `${kinds.slice(0, -1).join(', ')}, or ${kinds[kinds.length - 1]}`
  return `You'll always get an email when someone mentions ${list}.`
}

export function Profile() {
  usePageTitle('Account')
  const { user, setTitle, setName, setEmailDigestEnabled, setEmailDigestMatchesEnabled, setEmailRepliesEnabled } = useAuth()
  const { demoLocked } = useDemo()
  const { config } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const adminOffNote = `Turned off by your ${orgNoun}.`

  // Deep-link from the email footers: #setting-email-replies / #setting-email-digest /
  // #setting-week-ahead scrolls the matching toggle into view and amber-flashes it (~1.5s), the same
  // pattern BillDetail uses for #section-* / #comment- anchors.
  const location = useLocation()
  const [flashedSetting, setFlashedSetting] = useState<string | null>(null)
  const [colorMode, setColorModeState] = useState<ColorMode>(getColorMode)
  useEffect(() => {
    const id = location.hash.slice(1)
    if (id !== 'setting-email-replies' && id !== 'setting-email-digest' && id !== 'setting-week-ahead') return
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlashedSetting(id)
    const t = setTimeout(() => setFlashedSetting(null), 1500)
    return () => clearTimeout(t)
  }, [location.hash])

  // Name editing
  const [nameInput, setNameInput] = useState('')

  useEffect(() => {
    setNameInput(user?.name ?? '')
  }, [user?.name])

  // Title editing
  const [titleInput, setTitleInput] = useState(user?.title ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync input if user changes externally
  useEffect(() => {
    setTitleInput(user?.title ?? '')
  }, [user?.title])

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  // Modules config (for digest cadence description)
  const [modules, setModules] = useState<ModulesConfig | undefined>(undefined)
  useEffect(() => {
    apiFetch<{ modules?: ModulesConfig }>('/config').then((c) => setModules(c.modules)).catch(() => {})
  }, [])

  // How many roles this member is in, for the always-sent mention line. Until
  // /roles answers, or if it fails, the line leaves roles out.
  const [roleCount, setRoleCount] = useState(0)
  useEffect(() => {
    apiFetch<Array<{ members?: Array<{ id: string }> }>>('/roles')
      .then((roles) => setRoleCount(Array.isArray(roles) ? roles.filter((r) => r.members?.some((m) => m.id === user?.id)).length : 0))
      .catch(() => {})
  }, [user?.id])

  // The saved views the member has included in their digest (#449), for the description and the chips.
  // A failed or empty read is no views: the description then says what it always did.
  const [includedViews, setIncludedViews] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    apiFetch<{ views?: Array<{ id: string; name: string; subscribed?: boolean }> }>('/views')
      .then((d) => setIncludedViews((d.views ?? []).filter((v) => v.subscribed).map(({ id, name }) => ({ id, name }))))
      .catch(() => {})
  }, [])

  async function removeIncludedView(id: string) {
    if (demoLocked) return
    const before = includedViews
    setIncludedViews(before.filter((v) => v.id !== id))
    try {
      await apiFetch(`/views/${id}/subscription`, { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
    } catch {
      // revert on failure
      setIncludedViews(before)
    }
  }

  // Admin master switch per feature. While modules is still loading (undefined),
  // assume on so we don't flash a "turned off" state before /config resolves.
  const digestAdminOff = modules !== undefined && !isModuleEnabled(modules, 'email-digest')
  const weekAheadAdminOff = modules !== undefined && !isModuleEnabled(modules, 'week-ahead')

  // Email digest toggle
  const [digestEnabled, setDigestEnabled] = useState<boolean>(() => user?.emailDigestEnabled ?? true)
  const [digestSaving, setDigestSaving] = useState(false)

  useEffect(() => {
    setDigestEnabled(user?.emailDigestEnabled ?? true)
  }, [user?.emailDigestEnabled])

  // "Also include newly matched bills in the digest", nested under the digest switch. Admins always
  // get the new-match section, so only members are offered it.
  const isMember = user?.role === 'member'
  const [digestMatchesEnabled, setDigestMatchesEnabled] = useState<boolean>(() => user?.emailDigestMatchesEnabled ?? true)
  const [digestMatchesSaving, setDigestMatchesSaving] = useState(false)

  useEffect(() => {
    setDigestMatchesEnabled(user?.emailDigestMatchesEnabled ?? true)
  }, [user?.emailDigestMatchesEnabled])

  // Reply notifications, in the app and by email, are a per-member switch. The
  // instance's "Conversation emails" switch lives on the admin page and gates
  // only the email.
  const [repliesEnabled, setRepliesEnabled] = useState<boolean>(() => user?.emailRepliesEnabled ?? true)
  const [repliesSaving, setRepliesSaving] = useState(false)

  useEffect(() => {
    setRepliesEnabled(user?.emailRepliesEnabled ?? true)
  }, [user?.emailRepliesEnabled])

  const [weekAheadEnabled, setWeekAheadEnabled] = useState<boolean>(() => user?.emailWeekAheadEnabled ?? true)
  const [weekAheadSaving, setWeekAheadSaving] = useState(false)

  useEffect(() => {
    setWeekAheadEnabled(user?.emailWeekAheadEnabled ?? true)
  }, [user?.emailWeekAheadEnabled])

  async function handleDigestToggle() {
    if (demoLocked || digestAdminOff || digestSaving) return
    const next = !digestEnabled
    setDigestEnabled(next)
    setDigestSaving(true)
    try {
      await apiFetch('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ emailDigestEnabled: next }),
      })
      setEmailDigestEnabled(next)
    } catch {
      // revert on failure
      setDigestEnabled(!next)
    } finally {
      setDigestSaving(false)
    }
  }

  async function toggleDigestMatches() {
    if (demoLocked || digestAdminOff || !digestEnabled || digestMatchesSaving) return
    const next = !digestMatchesEnabled
    setDigestMatchesEnabled(next)
    setDigestMatchesSaving(true)
    try {
      await apiFetch('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ emailDigestMatchesEnabled: next }),
      })
      setEmailDigestMatchesEnabled(next)
    } catch {
      setDigestMatchesEnabled(!next)
    } finally {
      setDigestMatchesSaving(false)
    }
  }

  async function toggleReplies() {
    if (demoLocked || repliesSaving) return
    const next = !repliesEnabled
    setRepliesEnabled(next)
    setRepliesSaving(true)
    try {
      await apiFetch('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ emailRepliesEnabled: next }),
      })
      setEmailRepliesEnabled(next)
    } catch {
      setRepliesEnabled(!next)
    } finally {
      setRepliesSaving(false)
    }
  }

  async function toggleWeekAhead() {
    if (demoLocked || weekAheadAdminOff || weekAheadSaving) return
    const next = !weekAheadEnabled
    setWeekAheadEnabled(next)
    setWeekAheadSaving(true)
    try {
      await apiFetch('/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ emailWeekAheadEnabled: next }),
      })
    } finally {
      setWeekAheadSaving(false)
    }
  }

  async function handleSave() {
    if (saving || demoLocked) return
    setSaving(true)
    try {
      const payload = {
        name: nameInput.trim(),
        title: titleInput.trim() === '' ? null : titleInput.trim(),
      }
      await apiFetch('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      // A blank name clears it; the user then shows by email wherever a name
      // would appear. The field shows what was saved (trimmed, or blank).
      setName(payload.name)
      setNameInput(payload.name)
      setTitle(payload.title)
      setSaved(true)
      setSaveError(null)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
    } catch {
      setSaveError('Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  // Change email, inline in the email row. Nothing changes until the new
  // address confirms, so the row only asks for the address and reports where
  // the link went. The states live in lib/emailChangeState. No human check:
  // the session already proves who is asking.
  const [emailChange, dispatchEmailChange] = useReducer(emailChangeReducer, EMAIL_CHANGE_IDLE)
  const changeEmailReady = emailChange.kind === 'editing' && !emailChange.sending && !!emailChange.value.trim()
  const resendReady = emailChange.kind === 'pending' && !emailChange.busy
  const resendBusy = emailChange.kind === 'pending' && emailChange.busy
  const emailErrorId = useId()
  const emailInputRef = useRef<HTMLInputElement>(null)
  const changeEmailButtonRef = useRef<HTMLButtonElement>(null)
  const resendButtonRef = useRef<HTMLButtonElement>(null)
  // Where keyboard focus goes after the next render. The `n` makes a repeat
  // request for the same place count as a new one.
  const [emailFocus, setEmailFocus] = useState<{ target: 'input' | 'open' | 'resend'; n: number } | null>(null)
  function focusEmail(target: 'input' | 'open' | 'resend') {
    setEmailFocus(prev => ({ target, n: (prev?.n ?? 0) + 1 }))
  }
  useEffect(() => {
    if (!emailFocus) return
    const el = { input: emailInputRef, open: changeEmailButtonRef, resend: resendButtonRef }[emailFocus.target].current
    el?.focus()
  }, [emailFocus, emailChange.kind, resendBusy])

  // The change confirmed from the new address: the account email caught up.
  useEffect(() => {
    if (emailChange.kind === 'pending' && user?.email && user.email.toLowerCase() === emailChange.to.toLowerCase()) {
      dispatchEmailChange({ type: 'confirmed', email: user.email })
    }
  }, [user?.email, emailChange])

  function openChangeEmail() {
    if (demoLocked) return
    dispatchEmailChange({ type: 'open' })
    focusEmail('input')
  }

  function cancelChangeEmail() {
    dispatchEmailChange({ type: 'cancel' })
    focusEmail('open')
  }

  function escapeCancelsEdit(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && !(emailChange.kind === 'editing' && emailChange.sending)) {
      e.preventDefault()
      cancelChangeEmail()
    }
  }

  async function requestEmailChange(email: string, resend: boolean) {
    dispatchEmailChange({ type: resend ? 'resend' : 'send' })
    try {
      const r = await apiFetch<{ ok: true; email: string }>('/users/me/email-change', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      if (resend) {
        dispatchEmailChange({ type: 'resent', announce: `Link sent again to ${r.email}.` })
      } else {
        dispatchEmailChange({
          type: 'sent',
          to: r.email,
          announce: `Link sent to ${r.email}. Your email stays ${user?.email} until you confirm it. The link expires in 24 hours.`,
        })
      }
      focusEmail('resend')
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to send the confirmation. Please try again.'
      if (resend) {
        dispatchEmailChange({ type: 'resendFailed', message })
        focusEmail('resend')
      } else {
        dispatchEmailChange({ type: 'refused', message })
        focusEmail('input')
      }
    }
  }

  function handleChangeEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!changeEmailReady || emailChange.kind !== 'editing') return
    void requestEmailChange(emailChange.value, false)
  }

  // Account: login activity, deactivation, deletion
  const [activityOpen, setActivityOpen] = useState(false)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityError, setActivityError] = useState<string | null>(null)
  const [authEvents, setAuthEvents] = useState<AccountAuthEvent[] | null>(null)

  async function handleToggleActivity() {
    if (activityOpen) {
      setActivityOpen(false)
      return
    }
    setActivityOpen(true)
    if (authEvents !== null) return
    setActivityLoading(true)
    setActivityError(null)
    try {
      const data = await apiFetch<{ events: AccountAuthEvent[] }>('/users/me/auth-events')
      setAuthEvents(data.events)
    } catch {
      setActivityError('Failed to load login activity.')
    } finally {
      setActivityLoading(false)
    }
  }

  // A sole owner can't demote, deactivate, or delete — doing so would leave
  // the account ownerless. Server-computed; only ever true for role === 'owner'.
  const gated = !!user?.isLastOwner
  const lastOwnerBlock = "You're the only owner. Make another member an owner before you can demote, deactivate, or delete your account."

  const [deactivating, setDeactivating] = useState(false)

  async function handleDeactivate() {
    if (demoLocked || deactivating || gated) return
    if (!window.confirm("Deactivate your account?\n\nYou'll be logged out immediately. An admin can reactivate it later.")) return
    setDeactivating(true)
    try {
      await apiFetch('/users/me/deactivate', { method: 'POST' })
      window.location.href = '/'
    } catch {
      setDeactivating(false)
      alert('Failed to deactivate your account. Please try again.')
    }
  }

  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Self role-change (demote): owner -> admin, admin -> member. No self-promote.
  const demoteTarget = user?.role === 'owner' ? 'admin' : user?.role === 'admin' ? 'member' : null
  const [demoting, setDemoting] = useState(false)

  async function handleSelfDemote() {
    if (!user || !demoteTarget || demoLocked || demoting || gated) return
    const label = demoteTarget === 'admin' ? 'Admin' : 'Member'
    if (!window.confirm(`Demote yourself to ${label}?\n\nYou may lose access to some features immediately.`)) return
    setDemoting(true)
    try {
      await apiFetch(`/admin/members/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: demoteTarget }) })
      window.location.href = demoteTarget === 'member' ? '/' : '/account'
    } catch (err) {
      setDemoting(false)
      alert(err instanceof ApiError ? err.message : 'Failed to change your role.')
    }
  }

  async function handleDeleteAccount() {
    if (demoLocked || deleting || gated) return
    if (!window.confirm('Permanently delete your account?\n\nThis removes your account and all its activity (votes, comments, and notes). This cannot be undone.')) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiFetch('/users/me', { method: 'DELETE' })
      window.location.href = '/'
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete your account. Please try again.')
      setDeleting(false)
    }
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
      <SettingsNav />

      {demoLocked && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, padding: '8px 12px', background: color.surfaceSubtle, borderRadius: radius.md, border: `1px solid ${color.borderDefault}` }}>
          This is a demo — settings are read-only.
        </div>
      )}

      {/* Profile card */}
      <div style={SECTION_CARD}>
        <h1 style={CARD_TITLE}>Profile</h1>
        {user?.isSuperadmin ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              <div>
                <span style={FORM_LABEL}>Name</span>
                <div style={{ fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: color.textPrimary }}>{user.name || '—'}</div>
              </div>
              <div>
                <span style={FORM_LABEL}>Email</span>
                <div style={{ fontSize: fontSize.base, color: color.textPrimary }}>{user.email}</div>
              </div>
            </div>
            <div>
              <span style={FORM_LABEL}>Title</span>
              <div style={{ fontSize: fontSize.base, color: color.textPrimary }}>{user.title || '—'}</div>
              <div style={{ ...HELPER_TEXT, marginTop: 4 }}>
                Your name and title are managed in the{' '}
                {config?.centralDashboardUrl
                  ? <a href={`${config.centralDashboardUrl}/profile`} target="_blank" rel="noopener noreferrer" style={{ color: color.linkBlue }}>admin dashboard</a>
                  : 'admin dashboard'}. They update here when you sign in from the admin dashboard.
              </div>
            </div>
          </>
        ) : (
          <>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
          <div>
            <label style={FORM_LABEL} htmlFor="name-input">Name</label>
            <input
              id="name-input"
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Your name"
              style={{
                display: 'block',
                width: '100%',
                fontSize: fontSize.base,
                fontWeight: fontWeight.semibold,
                padding: '6px 10px',
                border: `1px solid ${color.borderStrong}`,
                borderRadius: radius.md,
                outline: 'none',
                color: color.textPrimary,
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div data-testid="email-row">
            <span style={FORM_LABEL}>Email</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontSize: fontSize.base, color: color.textPrimary, overflowWrap: 'anywhere' }}>{user?.email ?? '—'}</span>
              {(emailChange.kind === 'idle' || emailChange.kind === 'confirmed') && (
                <button
                  type="button"
                  ref={changeEmailButtonRef}
                  onClick={openChangeEmail}
                  disabled={demoLocked}
                  style={{
                    background: 'none', border: 'none', padding: 0, fontSize: fontSize.sm,
                    color: demoLocked ? color.textMuted : color.linkBlue,
                    cursor: demoLocked ? 'not-allowed' : 'pointer',
                  }}
                >
                  Change email…
                </button>
              )}
            </div>

            {emailChange.kind === 'editing' && (
              <form
                onSubmit={handleChangeEmail}
                style={{ marginTop: 6 }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <input
                    ref={emailInputRef}
                    type="email"
                    autoComplete="email"
                    aria-label="New email"
                    value={emailChange.value}
                    onChange={(e) => dispatchEmailChange({ type: 'edit', value: e.target.value })}
                    onKeyDown={escapeCancelsEdit}
                    aria-invalid={emailChange.error ? 'true' : undefined}
                    aria-describedby={emailChange.error ? emailErrorId : undefined}
                    style={{
                      flex: '1 1 160px', minWidth: 0, fontSize: fontSize.base, padding: '6px 10px',
                      border: `1px solid ${emailChange.error ? color.textErrorRed : color.borderStrong}`,
                      borderRadius: radius.md, outline: 'none', color: color.textPrimary, boxSizing: 'border-box',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!changeEmailReady}
                    style={{
                      ...primaryButtonColors(!changeEmailReady), border: 'none', borderRadius: radius.md,
                      padding: '6px 14px', fontSize: fontSize.sm, fontWeight: fontWeight.medium,
                      cursor: changeEmailReady ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {emailChange.sending ? 'Sending…' : 'Send link'}
                  </button>
                  <button
                    type="button"
                    onClick={cancelChangeEmail}
                    onKeyDown={escapeCancelsEdit}
                    disabled={emailChange.sending}
                    style={{
                      background: 'none', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
                      padding: '6px 12px', fontSize: fontSize.sm, color: color.textSecondary,
                      cursor: emailChange.sending ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
                {emailChange.error && (
                  <div id={emailErrorId} role="alert" style={{ fontSize: fontSize.sm, color: color.textErrorRed, marginTop: 6 }}>{emailChange.error}</div>
                )}
              </form>
            )}

            <EmailChangePill
              state={emailChange}
              onResend={() => { if (emailChange.kind === 'pending' && resendReady) void requestEmailChange(emailChange.to, true) }}
              onCancel={cancelChangeEmail}
              resendDisabled={!resendReady}
              resendRef={resendButtonRef}
              confirmedAnnounce={user?.email ? `Your email is now ${user.email}.` : undefined}
            />
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={FORM_LABEL} htmlFor="title-input">Title</label>
          <input
            id="title-input"
            type="text"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            placeholder="e.g. County Clerk, Greene County"
            style={{
              display: 'block',
              width: '100%',
              maxWidth: 400,
              fontSize: fontSize.base,
              padding: '8px 12px',
              border: `1px solid ${color.borderStrong}`,
              borderRadius: radius.md,
              outline: 'none',
              color: color.textPrimary,
              boxSizing: 'border-box',
            }}
          />
          <div style={{ ...HELPER_TEXT, marginTop: 4 }}>
            Shown alongside your name in comments.
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSave}
            disabled={saving || demoLocked}
            style={{
              ...primaryButtonColors(saving || demoLocked),
              border: 'none',
              borderRadius: radius.md,
              padding: '8px 20px',
              cursor: saving || demoLocked ? 'not-allowed' : 'pointer',
              fontSize: fontSize.base,
              fontWeight: fontWeight.medium,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && (
            <span style={{ fontSize: fontSize.sm, color: color.textSuccess, fontWeight: fontWeight.medium }}>Saved</span>
          )}
          {saveError && (
            <span style={{ fontSize: fontSize.sm, color: color.textErrorRed, fontWeight: fontWeight.medium }}>{saveError}</span>
          )}
        </div>
          </>
        )}
      </div>

      {/* Notifications card: every email a member can control, the digests first and replies last (the same order as Team notifications), plus the always-sent line */}
      <div style={SECTION_CARD}>
        <h2 style={CARD_TITLE}>Notifications</h2>
        <p style={{ ...HELPER_TEXT, marginTop: 0, marginBottom: 12 }}>
          {alwaysEmailedLine(user?.role === 'admin' || user?.role === 'owner', roleCount)}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div
            id="setting-email-digest"
            style={{
              padding: '12px 14px',
              border: `1px solid ${color.borderDefault}`,
              borderRadius: radius.lg,
              background: color.white,
              opacity: demoLocked || digestAdminOff ? 0.55 : 1,
              boxShadow: flashedSetting === 'setting-email-digest' ? `0 0 0 3px ${color.borderAmber}` : undefined,
              transition: 'box-shadow 0.6s ease',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: demoLocked || digestAdminOff ? 'not-allowed' : 'pointer' }}>
              <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
                <div style={{ fontWeight: fontWeight.bold, color: color.textPrimary }}>Email digest of recent bill activity</div>
                <div>{digestCadenceDescription(modules, includedViews.length > 0)}</div>
                {digestAdminOff && (
                  <div style={{ marginTop: 2, color: color.textMuted, fontWeight: fontWeight.medium }}>{adminOffNote}</div>
                )}
              </div>
              <span
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 38,
                  height: 24,
                  flexShrink: 0,
                  cursor: demoLocked || digestAdminOff ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  role="switch"
                  className="fv-switch-input"
                  aria-label="Toggle Email digest of recent bill activity"
                  checked={digestEnabled}
                  disabled={digestSaving || demoLocked || digestAdminOff}
                  onChange={handleDigestToggle}
                  style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: digestEnabled ? color.accentBlue : color.borderStrong,
                    borderRadius: radius.pill,
                    transition: 'background 0.18s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: digestEnabled ? 16 : 2,
                    width: 20,
                    height: 20,
                    background: color.white,
                    borderRadius: '50%',
                    transition: 'left 0.18s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                  }}
                />
              </span>
            </label>
            {/* Outside the label above, so a click on a chip never toggles the digest switch. */}
            {!digestAdminOff && includedViews.length > 0 && (
              <ul aria-label="Saved views in your digest" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 0', padding: 0, listStyle: 'none' }}>
                {includedViews.map((v) => (
                  <li
                    key={v.id}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 10px',
                      border: `1px solid ${color.borderDefault}`, borderRadius: radius.pill,
                      fontSize: fontSize.sm, color: color.textSlate, background: color.white,
                    }}
                  >
                    {v.name}
                    <button
                      type="button"
                      aria-label={`Remove ${v.name} from your digest`}
                      disabled={demoLocked}
                      onClick={() => { void removeIncludedView(v.id) }}
                      style={{
                        fontFamily: 'inherit', fontSize: fontSize.base, lineHeight: 1, background: 'none', border: 'none',
                        color: color.textSecondary, cursor: demoLocked ? 'not-allowed' : 'pointer', minWidth: 24, minHeight: 24, borderRadius: radius.pill,
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {isMember && (
              <label
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
                  cursor: demoLocked || digestAdminOff || !digestEnabled ? 'not-allowed' : 'pointer',
                  marginTop: 10, paddingTop: 10, borderTop: `1px solid ${color.borderDefault}`,
                  opacity: digestEnabled ? 1 : 0.55,
                }}
              >
                <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
                  <div id="digest-matches-label" style={{ color: color.textPrimary }}>{digestMatchesLabel(modules)}</div>
                </div>
                <span
                  style={{
                    position: 'relative',
                    display: 'inline-block',
                    width: 38,
                    height: 24,
                    flexShrink: 0,
                    cursor: demoLocked || digestAdminOff || !digestEnabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    className="fv-switch-input"
                    aria-labelledby="digest-matches-label"
                    checked={digestMatchesEnabled}
                    disabled={digestMatchesSaving || demoLocked || digestAdminOff || !digestEnabled}
                    onChange={toggleDigestMatches}
                    style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: digestMatchesEnabled ? color.accentBlue : color.borderStrong,
                      borderRadius: radius.pill,
                      transition: 'background 0.18s ease',
                    }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      left: digestMatchesEnabled ? 16 : 2,
                      width: 20,
                      height: 20,
                      background: color.white,
                      borderRadius: '50%',
                      transition: 'left 0.18s ease',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                    }}
                  />
                </span>
              </label>
            )}
          </div>

          <div
            id="setting-week-ahead"
            style={{
              padding: '12px 14px',
              border: `1px solid ${color.borderDefault}`,
              borderRadius: radius.lg,
              background: color.white,
              opacity: demoLocked || weekAheadAdminOff ? 0.55 : 1,
              boxShadow: flashedSetting === 'setting-week-ahead' ? `0 0 0 3px ${color.borderAmber}` : undefined,
              transition: 'box-shadow 0.6s ease',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: demoLocked || weekAheadAdminOff ? 'not-allowed' : 'pointer' }}>
              <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
                <div style={{ fontWeight: fontWeight.bold, color: color.textPrimary }}>Email digest of upcoming hearings and events</div>
                <div>{weekAheadCadenceDescription(modules)}</div>
                {weekAheadAdminOff && (
                  <div style={{ marginTop: 2, color: color.textMuted, fontWeight: fontWeight.medium }}>{adminOffNote}</div>
                )}
              </div>
              <span
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 38,
                  height: 24,
                  flexShrink: 0,
                  cursor: demoLocked || weekAheadAdminOff ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  role="switch"
                  className="fv-switch-input"
                  aria-label="Toggle Email digest of upcoming hearings and events"
                  checked={weekAheadEnabled}
                  disabled={weekAheadSaving || demoLocked || weekAheadAdminOff}
                  onChange={toggleWeekAhead}
                  style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: weekAheadEnabled ? color.accentBlue : color.borderStrong,
                    borderRadius: radius.pill,
                    transition: 'background 0.18s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: weekAheadEnabled ? 16 : 2,
                    width: 20,
                    height: 20,
                    background: color.white,
                    borderRadius: '50%',
                    transition: 'left 0.18s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                  }}
                />
              </span>
            </label>
          </div>

          <div
            id="setting-email-replies"
            style={{
              padding: '12px 14px',
              border: `1px solid ${color.borderDefault}`,
              borderRadius: radius.lg,
              background: color.white,
              opacity: demoLocked ? 0.55 : 1,
              boxShadow: flashedSetting === 'setting-email-replies' ? `0 0 0 3px ${color.borderAmber}` : undefined,
              transition: 'box-shadow 0.6s ease',
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, cursor: demoLocked ? 'not-allowed' : 'pointer' }}>
              <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
                <div style={{ fontWeight: fontWeight.bold, color: color.textPrimary }}>Replies on bills you've commented on</div>
                <div>Notify me in FloorVote and by email when someone else comments on a bill I've commented on. To stop them on one bill, select “Mute comments” on that bill.</div>
              </div>
              <span
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 38,
                  height: 24,
                  flexShrink: 0,
                  cursor: demoLocked ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  role="switch"
                  className="fv-switch-input"
                  aria-label="Toggle Replies on bills you've commented on"
                  checked={repliesEnabled}
                  disabled={repliesSaving || demoLocked}
                  onChange={toggleReplies}
                  style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: repliesEnabled ? color.accentBlue : color.borderStrong,
                    borderRadius: radius.pill,
                    transition: 'background 0.18s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: repliesEnabled ? 16 : 2,
                    width: 20,
                    height: 20,
                    background: color.white,
                    borderRadius: '50%',
                    transition: 'left 0.18s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                  }}
                />
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Appearance card: display preferences, saved in this browser */}
      <div style={SECTION_CARD}>
        <h2 style={CARD_TITLE}>Appearance</h2>
        <div
          id="setting-color-mode"
          style={{
            padding: '12px 14px',
            border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.lg,
            background: color.white,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
            <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
              <div id="color-mode-label" style={{ fontWeight: fontWeight.bold, color: color.textPrimary }}>Color mode</div>
              <div>System follows your device. Saved in this browser.</div>
            </div>
            <div
              role="group"
              aria-labelledby="color-mode-label"
              style={{ display: 'inline-flex', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, overflow: 'hidden', flexShrink: 0 }}
            >
              {COLOR_MODES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={colorMode === value}
                  onClick={() => { setColorMode(value); setColorModeState(value) }}
                  style={{
                    padding: '5px 12px',
                    fontSize: fontSize.sm,
                    cursor: 'pointer',
                    border: 'none',
                    background: colorMode === value ? color.bgAmberPriority : color.white,
                    color: colorMode === value ? color.billBadgeNavy : color.textSlate,
                    fontWeight: colorMode === value ? fontWeight.semibold : fontWeight.normal,
                    fontFamily: 'inherit',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Account card */}
      <div style={SECTION_CARD}>
        <h2 style={CARD_TITLE}>Account</h2>

        {/* Login activity */}
        <div style={actionRowStyleFirst}>
          <button
            onClick={handleToggleActivity}
            disabled={activityLoading}
            style={actionBtnBlue(activityLoading)}
          >
            Show my login activity
          </button>
        </div>

        {activityOpen && (
          <div style={{ marginTop: 12, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, padding: '4px 14px' }}>
            {activityLoading && (
              <div style={{ fontSize: fontSize.sm, color: color.textMuted, padding: '8px 0' }}>Loading…</div>
            )}
            {activityError && (
              <div style={{ fontSize: fontSize.sm, color: color.textErrorRed, padding: '8px 0' }}>{activityError}</div>
            )}
            {!activityLoading && !activityError && authEvents && (
              authEvents.length === 0 ? (
                <div style={{ fontSize: fontSize.sm, color: color.textMuted, padding: '8px 0' }}>No login activity recorded.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {authEvents.map((event, index) => (
                    <div
                      key={event.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 16,
                        padding: '8px 0',
                        borderBottom: index === authEvents.length - 1 ? 'none' : `1px solid ${color.surfaceMuted}`,
                      }}
                    >
                      <div style={{ fontSize: fontSize.sm, color: color.textSlate }}>{accountEventLabel(event, user?.id ?? '')}</div>
                      <div
                        title={absoluteTime(event.createdAt)}
                        style={{ fontSize: fontSize.sm, color: color.textMuted, whiteSpace: 'nowrap', flexShrink: 0 }}
                      >
                        {relativeTime(event.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
            {!activityLoading && !activityError && authEvents && authEvents.length >= 50 && (
              <div style={{ fontSize: fontSize.xs, color: color.textMuted, paddingTop: 8 }}>
                Showing the 50 most recent events.
              </div>
            )}
          </div>
        )}

        {/* Demote yourself (owner -> admin, admin -> member); no self-promote */}
        {demoteTarget && (
          <div style={actionRowStyle}>
            <button
              onClick={handleSelfDemote}
              disabled={demoLocked || demoting || gated}
              style={actionBtnRed(demoLocked || demoting || gated)}
            >
              {demoteTarget === 'admin' ? 'Demote my account from Owner to Admin' : 'Demote my account from Admin to Member'}
            </button>
            <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
              {gated
                ? lastOwnerBlock
                : demoteTarget === 'admin'
                  ? 'Immediately lose your owner permissions. An owner can restore your role later.'
                  : 'Immediately lose your admin permissions. An owner or admin can restore your role later.'}
            </span>
          </div>
        )}

        {/* Deactivate my account */}
        <div style={actionRowStyle}>
          <button
            onClick={handleDeactivate}
            disabled={demoLocked || deactivating || gated}
            style={actionBtnRed(demoLocked || deactivating || gated)}
          >
            {deactivating ? 'Deactivating…' : 'Deactivate my account'}
          </button>
          <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
            {gated
              ? lastOwnerBlock
              : "You'll be logged out immediately and your activity (votes, comments, and notes) will be hidden. An admin can reactivate your account and activity later."}
          </span>
        </div>

        {/* Delete my account (only when enabled by the operator) */}
        {config?.accountDeletionEnabled && (
          <div style={actionRowStyle}>
            <button
              onClick={handleDeleteAccount}
              disabled={demoLocked || deleting || gated}
              style={actionBtnRed(demoLocked || deleting || gated)}
            >
              {deleting ? 'Deleting…' : 'Delete my account'}
            </button>
            <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
              {gated
                ? lastOwnerBlock
                : 'Permanently remove your account and all its activity (votes, comments, and notes). This cannot be undone.'}
            </span>
            {deleteError && (
              <span style={{ fontSize: fontSize.sm, color: color.textErrorRed, flexShrink: 0 }}>{deleteError}</span>
            )}
          </div>
        )}
      </div>

    </div>
  )
}
