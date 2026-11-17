import { useState } from 'react'
import { useConfig } from '../../context/ConfigContext'
import { useDemo } from '../../context/DemoContext'
import { apiFetch } from '../../lib/api'
import { DEFAULT_WEEK_AHEAD_DAY } from '../../lib/notifications'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, HELPER_TEXT } from '../../lib/textStyles'
import { settingBox, SETTING_BOX_HEADER, SETTING_BOX_TITLE, SETTING_BOX_DESC } from '../../lib/settingBoxStyle'
import { IosToggle } from '../../components/ui/IosToggle'
import { ScopeSelect } from '../../components/ui/ScopeSelect'
import { DEFAULT_ORG_NOUN } from '../../lib/orgNoun'
import { weekAheadDescription } from '../notifications/copy'
import { color, fontSize } from '../../styles/tokens'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// The dropdown's choices, Sunday (0) to Saturday (6), as week_ahead_day stores them.
const DAY_OPTIONS = DAYS.map((label, i) => ({ value: String(i), label }))

const CONFIRM_OFF = 'Turn off email to members? No one will get the email digest, the week ahead email, or mention and reply emails until you turn it back on. Sign-in links and invites still send.'
const SAVE_ERROR = "Couldn't save that change. Try again."

interface Props {
  /** True until /admin/config answers. The box shows Loading… then, like the page's other sections, so nobody saves over a value not yet read. */
  loading: boolean
  /** From the /admin/config load. Missing reads as on. */
  emailsEnabled: boolean | undefined
  /** From the /admin/config load. Missing reads as Friday. */
  weekAheadDay: number | undefined
}

/**
 * The admin's two email settings: one switch for all email to members, and the day the week ahead email goes out.
 * Each saves at once. What each person gets is their own choice on the Notifications tab.
 */
export function EmailsSection({ loading, emailsEnabled, weekAheadDay }: Props) {
  return (
    <div style={{ ...CARD, padding: 24, marginBottom: 20 }}>
      <h2 style={CARD_TITLE}>Emails</h2>
      {loading
        ? <div style={{ ...HELPER_TEXT, marginTop: 4 }}>Loading…</div>
        // Drawn only once the saved settings are in, so its first draw already shows them.
        : <EmailsControls emailsEnabled={emailsEnabled} weekAheadDay={weekAheadDay} />}
    </div>
  )
}

function EmailsControls({ emailsEnabled, weekAheadDay }: Omit<Props, 'loading'>) {
  const { demoLocked } = useDemo()
  const { config, patchConfig } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const [on, setOn] = useState(emailsEnabled !== false)
  const [day, setDay] = useState(weekAheadDay ?? DEFAULT_WEEK_AHEAD_DAY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)

  async function save(body: Record<string, unknown>, onSaved: () => void, putBack: () => void) {
    setError(false)
    setSaving(true)
    try {
      await apiFetch('/admin/config', { method: 'PUT', body: JSON.stringify(body) })
      onSaved()
    } catch {
      putBack()
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  function changeEmails(next: boolean) {
    if (saving) return
    // Turning it off stops email for everyone, so ask first. Turning it on needs no question.
    if (!next && !window.confirm(CONFIRM_OFF)) return
    setOn(next)
    void save({ notification_emails_enabled: next }, () => patchConfig?.({ notificationEmailsEnabled: next }), () => setOn(!next))
  }

  function changeDay(next: number) {
    if (saving || next === day) return
    const before = day
    setDay(next)
    void save({ week_ahead_day: next }, () => patchConfig?.({ weekAheadDay: next }), () => setDay(before))
  }

  return (
    <>
      <div style={settingBox(demoLocked)}>
        <div style={SETTING_BOX_HEADER}>
          <div>
            <div style={SETTING_BOX_TITLE}>Send email to members</div>
            <div style={SETTING_BOX_DESC}>
              The email digest, the week ahead email, and emails about mentions and replies. Each person chooses which of these they get on their Notifications tab. Sign-in links and invites always send.
            </div>
          </div>
          <IosToggle checked={on} disabled={demoLocked} busy={saving} onChange={changeEmails} ariaLabel="Send email to members" />
        </div>
      </div>
      {/* One row, like the switch above and How often on the Notifications tab: the title and what it is for on the
          left, the app's own dropdown on the right. */}
      <div style={{ ...settingBox(demoLocked), marginTop: 10 }}>
        <div style={SETTING_BOX_HEADER}>
          <div>
            <div style={SETTING_BOX_TITLE}>Week ahead email day</div>
            <div style={SETTING_BOX_DESC}>{weekAheadDescription(orgNoun)}</div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <ScopeSelect
              ariaLabel="Week ahead email day"
              options={DAY_OPTIONS}
              value={String(day)}
              disabled={demoLocked || saving}
              onChange={(v) => changeDay(Number(v))}
            />
          </div>
        </div>
      </div>
      {error && <div role="alert" style={{ marginTop: 8, fontSize: fontSize.sm, color: color.textErrorRed }}>{SAVE_ERROR}</div>}
    </>
  )
}
