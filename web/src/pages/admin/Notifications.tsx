import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { SettingsNav } from '../../components/SettingsNav'
import { IosToggle } from '../../components/ui/IosToggle'
import { isModuleEnabled, getModuleSetting } from '../../lib/modules'
import type { ModulesConfig } from '../../lib/modules'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE } from '../../lib/textStyles'
import { useSidebarRefresh } from '../../context/SidebarRefreshContext'
import { useDemo } from '../../context/DemoContext'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'

interface AdminConfigResponse {
  modules?: ModulesConfig
  mention_emails_enabled?: boolean
}

const WEEKDAYS = [
  ['0', 'Sunday'],
  ['1', 'Monday'],
  ['2', 'Tuesday'],
  ['3', 'Wednesday'],
  ['4', 'Thursday'],
  ['5', 'Friday'],
  ['6', 'Saturday'],
] as const

const PAGE: React.CSSProperties = { padding: '24px 32px', maxWidth: 900, margin: '0 auto' }

export function Notifications() {
  const refreshSidebar = useSidebarRefresh()
  const { demoLocked } = useDemo()
  const [modules, setModules] = useState<ModulesConfig>({})
  const [mentionEmails, setMentionEmails] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  // Turning a setting OFF stops email for everyone, so confirm first (browser confirm,
  // matching the rest of the app). Turning ON is benign — members can still opt out
  // individually — so it applies immediately.
  const confirmOff = (label: string) =>
    window.confirm(`Turn off ${label} for everyone? This stops it for all members, not just you. Members can also opt out individually on their Account page.`)

  useEffect(() => {
    apiFetch<AdminConfigResponse>('/admin/config')
      .then((d) => {
        setModules((d.modules ?? {}) as ModulesConfig)
        setMentionEmails(d.mention_emails_enabled !== false)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  async function putConfig(body: Record<string, unknown>, id: string) {
    setSaving(id)
    try {
      await apiFetch('/admin/config', { method: 'PUT', body: JSON.stringify(body) })
      refreshSidebar()
    } finally {
      setSaving(null)
    }
  }

  const digestEnabled = isModuleEnabled(modules, 'email-digest')
  const frequency = getModuleSetting<string>(modules, 'email-digest', 'frequency', 'daily')
  const weeklyDay = getModuleSetting<string>(modules, 'email-digest', 'weeklyDay', '1')
  const weekAheadEnabled = isModuleEnabled(modules, 'week-ahead')
  const weekAheadDay = getModuleSetting<string>(modules, 'week-ahead', 'weeklyDay', '1')

  function updateWeekAhead(next: { enabled?: boolean; weeklyDay?: string }) {
    const curEntry = modules['week-ahead']
    const curSettings =
      typeof curEntry === 'object' && curEntry !== null && 'settings' in curEntry
        ? (curEntry as { settings?: Record<string, unknown> }).settings ?? {}
        : {}
    const settings = {
      weeklyDay: weekAheadDay,
      ...curSettings,
      ...(next.weeklyDay != null ? { weeklyDay: next.weeklyDay } : {}),
    }
    const entry = { enabled: next.enabled ?? weekAheadEnabled, settings }
    const nextModules = { ...modules, 'week-ahead': entry }
    setModules(nextModules)
    void putConfig({ modules: nextModules }, 'week-ahead')
  }

  function updateDigest(next: { enabled?: boolean; frequency?: string; weeklyDay?: string }) {
    const curEntry = modules['email-digest']
    const curSettings =
      typeof curEntry === 'object' && curEntry !== null && 'settings' in curEntry
        ? (curEntry as { settings?: Record<string, unknown> }).settings ?? {}
        : {}
    const settings = {
      frequency,
      weeklyDay,
      ...curSettings,
      ...(next.frequency != null ? { frequency: next.frequency } : {}),
      ...(next.weeklyDay != null ? { weeklyDay: next.weeklyDay } : {}),
    }
    const entry = { enabled: next.enabled ?? digestEnabled, settings }
    const nextModules = { ...modules, 'email-digest': entry }
    setModules(nextModules)
    void putConfig({ modules: nextModules }, 'email-digest')
  }

  function updateMention(next: boolean) {
    setMentionEmails(next)
    void putConfig({ mention_emails_enabled: next }, 'mention')
  }

  const sel: React.CSSProperties = {
    fontSize: fontSize.sm,
    padding: '3px 6px',
    borderRadius: radius.sm,
    border: `1px solid ${color.borderDefault}`,
    fontFamily: 'inherit',
  }
  const settingBox: React.CSSProperties = {
    padding: '12px 14px',
    border: `1px solid ${color.borderDefault}`,
    borderRadius: radius.lg,
    background: color.white,
    opacity: demoLocked ? 0.55 : 1,
  }
  const boxHeader: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  }
  const boxTitle: React.CSSProperties = { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary }
  const boxDesc: React.CSSProperties = { fontSize: fontSize.sm, color: color.textSlate, lineHeight: 1.5, marginTop: 2 }

  return (
    <div style={PAGE}>
      <SettingsNav />

      {demoLocked && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, padding: '8px 12px', background: color.surfaceSubtle, borderRadius: radius.md, border: `1px solid ${color.borderDefault}` }}>
          This is a demo instance — settings are read-only.
        </div>
      )}

      <div style={{ ...CARD, padding: 24 }}>
        <div style={CARD_TITLE}>Email notifications</div>
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6, marginTop: 4 }}>
          These settings control email for <strong>everyone</strong>, not just you — turning one off stops it for all members. To change your own delivery, use the email preferences on your <Link to="/profile" style={{ color: color.partyDemBlue }}>Account page</Link>.
        </div>
        {loading ? (
          <div style={{ marginTop: 16, color: color.textMuted, fontSize: fontSize.sm }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            <div style={settingBox}>
              <div style={boxHeader}>
                <div>
                  <div style={boxTitle}>Send a digest of recent bill activity to users</div>
                  <div style={boxDesc}>
                    Email members a daily or weekly summary of recent activity on priority bills. Admins and owners also get a list of new bills matching your keywords awaiting a priority decision. Members can opt out individually on their Account page.
                  </div>
                </div>
                <IosToggle
                  checked={digestEnabled}
                  disabled={demoLocked}
                  busy={saving === 'email-digest'}
                  onChange={(n) => { if (!n && !confirmOff('the recent-activity digest')) return; updateDigest({ enabled: n }) }}
                  ariaLabel="Toggle email digest"
                />
              </div>
              <div
                style={{
                  marginTop: 12,
                  paddingLeft: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  opacity: digestEnabled ? 1 : 0.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ fontSize: fontSize.sm, color: color.textSlate500, minWidth: 120 }}>Frequency</label>
                  <select
                    value={frequency}
                    disabled={!digestEnabled || demoLocked}
                    onChange={(e) => updateDigest({ frequency: e.target.value })}
                    style={sel}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>
                {frequency === 'weekly' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <label style={{ fontSize: fontSize.sm, color: color.textSlate500, minWidth: 120 }}>Day of week</label>
                    <select
                      value={weeklyDay}
                      disabled={!digestEnabled || demoLocked}
                      onChange={(e) => updateDigest({ weeklyDay: e.target.value })}
                      style={sel}
                    >
                      {WEEKDAYS.map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div style={settingBox}>
              <div style={boxHeader}>
                <div>
                  <div style={boxTitle}>Send a digest of upcoming hearings and events to users</div>
                  <div style={boxDesc}>
                    Email members a weekly preview of upcoming hearings and events. Members can opt out individually on their Account page.
                  </div>
                </div>
                <IosToggle
                  checked={weekAheadEnabled}
                  disabled={demoLocked}
                  busy={saving === 'week-ahead'}
                  onChange={(n) => { if (!n && !confirmOff('the upcoming-hearings digest')) return; updateWeekAhead({ enabled: n }) }}
                  ariaLabel="Toggle week-ahead email"
                />
              </div>
              <div style={{ marginTop: 12, paddingLeft: 4, opacity: weekAheadEnabled ? 1 : 0.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ fontSize: fontSize.sm, color: color.textSlate500, minWidth: 120 }}>Day of week</label>
                  <select
                    value={weekAheadDay}
                    disabled={!weekAheadEnabled || demoLocked}
                    onChange={(e) => updateWeekAhead({ weeklyDay: e.target.value })}
                    style={sel}
                  >
                    {WEEKDAYS.map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div style={settingBox}>
              <div style={boxHeader}>
                <div>
                  <div style={boxTitle}>Send @-mention emails to users</div>
                  <div style={boxDesc}>
                    Email members when they (or a role they are assigned) are @-mentioned in a comment.
                  </div>
                </div>
                <IosToggle
                  checked={mentionEmails}
                  disabled={demoLocked}
                  busy={saving === 'mention'}
                  onChange={(n) => { if (!n && !confirmOff('@-mention emails')) return; updateMention(n) }}
                  ariaLabel="Toggle @-mention emails"
                />
              </div>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}
