import { useEffect, useState } from 'react'
import { useConfig } from '../../context/ConfigContext'
import { useDemo } from '../../context/DemoContext'
import { apiFetch } from '../../lib/api'
import { DEFAULT_WEEK_AHEAD_DAY } from '../../lib/notifications'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, HELPER_TEXT } from '../../lib/textStyles'
import { settingBox, SETTING_BOX_HEADER, SETTING_BOX_TITLE, SETTING_BOX_DESC } from '../../lib/settingBoxStyle'
import { IosToggle } from '../../components/ui/IosToggle'
import { color, radius, fontSize } from '../../styles/tokens'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const CONFIRM_OFF = 'Turn off email to members? No one will get the email digest, the week ahead email, or comment emails until you turn it back on. Sign-in links and invites still send.'
const SAVE_ERROR = "Couldn't save that change. Try again."

const SELECT: React.CSSProperties = { fontSize: fontSize.sm, padding: '8px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, boxSizing: 'border-box', fontFamily: 'inherit', color: color.textSlate, background: color.white }

interface Props {
  /** From the /admin/config load. Missing reads as on. */
  emailsEnabled: boolean | undefined
  /** From the /admin/config load. Missing reads as Friday. */
  weekAheadDay: number | undefined
}

/**
 * The admin's two email settings: one switch for all email to members, and the day the week ahead email goes out.
 * Each saves at once. What each person gets is their own choice on the Notifications tab.
 */
export function EmailsSection({ emailsEnabled, weekAheadDay }: Props) {
  const { demoLocked } = useDemo()
  const { patchConfig } = useConfig()
  const [on, setOn] = useState(emailsEnabled !== false)
  const [day, setDay] = useState(weekAheadDay ?? DEFAULT_WEEK_AHEAD_DAY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  // The settings arrive after the page first draws, so follow them when they do.
  useEffect(() => { setOn(emailsEnabled !== false) }, [emailsEnabled])
  useEffect(() => { setDay(weekAheadDay ?? DEFAULT_WEEK_AHEAD_DAY) }, [weekAheadDay])

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
    <div style={{ ...CARD, padding: 24, marginBottom: 20 }}>
      <h2 style={CARD_TITLE}>Emails</h2>
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
      <div style={{ marginTop: 14 }}>
        <label htmlFor="week-ahead-day" style={{ ...SETTING_BOX_TITLE, display: 'block', marginBottom: 4 }}>Week ahead email day</label>
        <select
          id="week-ahead-day"
          value={day}
          disabled={demoLocked || saving}
          onChange={(e) => changeDay(Number(e.target.value))}
          style={{ ...SELECT, cursor: demoLocked ? 'not-allowed' : 'pointer' }}
        >
          {DAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
        </select>
        <div style={{ ...HELPER_TEXT, marginTop: 4 }}>The day the week ahead email goes out, so you know when events need to be on the calendar.</div>
      </div>
      {error && <div role="alert" style={{ marginTop: 8, fontSize: fontSize.sm, color: color.textErrorRed }}>{SAVE_ERROR}</div>}
    </div>
  )
}
