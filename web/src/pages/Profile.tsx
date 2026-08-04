import { useState, useEffect, useRef } from 'react'
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
import { digestCadenceDescription, weekAheadCadenceDescription, isModuleEnabled } from '../lib/modules'
import type { ModulesConfig } from '../lib/modules'
import { DEFAULT_ORG_NOUN } from '../lib/orgNoun'

const SECTION_CARD: React.CSSProperties = { ...CARD, padding: 24, marginBottom: 20 }

type AccountAuthEvent = {
  id: string
  event: string
  reason: string | null
  linkType: string | null
  provider: string | null
  ipCountry: string | null
  createdAt: string
}

function accountEventLabel(e: AccountAuthEvent): string {
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
    default:
      return e.event
  }
}

export function Profile() {
  usePageTitle('Account')
  const { user, setSubtitle, setName, setEmailDigestEnabled } = useAuth()
  const { demoLocked } = useDemo()
  const { config } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const adminOffNote = `Turned off by your ${orgNoun}.`

  // Deep-link from the email footers: #setting-email-digest / #setting-week-ahead
  // scrolls the matching toggle into view and amber-flashes it (~1.5s), the same
  // pattern BillDetail uses for #section-* / #comment- anchors.
  const location = useLocation()
  const [flashedSetting, setFlashedSetting] = useState<string | null>(null)
  useEffect(() => {
    const id = location.hash.slice(1)
    if (id !== 'setting-email-digest' && id !== 'setting-week-ahead') return
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

  // Subtitle editing
  const [subtitleInput, setSubtitleInput] = useState(user?.subtitle ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync input if user changes externally
  useEffect(() => {
    setSubtitleInput(user?.subtitle ?? '')
  }, [user?.subtitle])

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
    setSaving(true)
    try {
      const payload = {
        name: nameInput.trim(),
        subtitle: subtitleInput.trim() === '' ? null : subtitleInput.trim(),
      }
      await apiFetch('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      setName(nameInput.trim())
      setSubtitle(payload.subtitle)
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
      window.location.href = demoteTarget === 'member' ? '/' : '/profile'
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
          This is a demo instance — settings are read-only.
        </div>
      )}

      {/* Profile card */}
      <div style={SECTION_CARD}>
        <h1 style={CARD_TITLE}>Profile</h1>
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
          <div>
            <span style={FORM_LABEL}>Email</span>
            <div style={{ fontSize: fontSize.base, color: color.textPrimary }}>{user?.email ?? '—'}</div>
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={FORM_LABEL} htmlFor="subtitle-input">Subtitle</label>
          <input
            id="subtitle-input"
            type="text"
            value={subtitleInput}
            onChange={(e) => setSubtitleInput(e.target.value)}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSave}
            disabled={saving || demoLocked}
            style={{
              background: color.accentBlue,
              color: color.white,
              border: 'none',
              borderRadius: radius.md,
              padding: '8px 20px',
              cursor: saving || demoLocked ? 'not-allowed' : 'pointer',
              fontSize: fontSize.base,
              fontWeight: fontWeight.medium,
              opacity: saving || demoLocked ? 0.5 : 1,
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
      </div>

      {/* Preferences card */}
      <div style={SECTION_CARD}>
        <h2 style={CARD_TITLE}>Preferences</h2>
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
                <div style={{ fontWeight: fontWeight.bold, color: color.textPrimary }}>Email digest of recent bill activity</div>
                <div>{digestCadenceDescription(modules)}</div>
                {digestAdminOff && (
                  <div style={{ marginTop: 2, color: color.textMuted, fontWeight: fontWeight.medium }}>{adminOffNote}</div>
                )}
              </div>
              <label
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 38,
                  height: 22,
                  flexShrink: 0,
                  cursor: demoLocked || digestAdminOff ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  role="switch"
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
                    left: digestEnabled ? 18 : 2,
                    width: 18,
                    height: 18,
                    background: color.white,
                    borderRadius: '50%',
                    transition: 'left 0.18s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                  }}
                />
              </label>
            </div>
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5 }}>
                <div style={{ fontWeight: fontWeight.bold, color: color.textPrimary }}>Email digest of upcoming hearings and events</div>
                <div>{weekAheadCadenceDescription(modules)}</div>
                {weekAheadAdminOff && (
                  <div style={{ marginTop: 2, color: color.textMuted, fontWeight: fontWeight.medium }}>{adminOffNote}</div>
                )}
              </div>
              <label
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 38,
                  height: 22,
                  flexShrink: 0,
                  cursor: demoLocked || weekAheadAdminOff ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  role="switch"
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
                    left: weekAheadEnabled ? 18 : 2,
                    width: 18,
                    height: 18,
                    background: color.white,
                    borderRadius: '50%',
                    transition: 'left 0.18s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
                  }}
                />
              </label>
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
                      <div style={{ fontSize: fontSize.sm, color: color.textSlate }}>{accountEventLabel(event)}</div>
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
