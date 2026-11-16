import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useConfig } from '../context/ConfigContext'
import { useDemo } from '../context/DemoContext'
import { DEFAULT_ORG_NOUN } from '../lib/orgNoun'
import { SettingsNav } from '../components/SettingsNav'
import { usePageTitle } from '../hooks/usePageTitle'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { NotificationCards } from './notifications/NotificationCards'
import { emailsOffLine } from './notifications/copy'
import { useSettingFlash } from './notifications/useSettingFlash'

// The anchors the email footers and List-Unsubscribe headers link to.
const SETTING_IDS = ['setting-email-digest', 'setting-saved-views', 'setting-week-ahead', 'setting-email-replies'] as const

const PAGE: React.CSSProperties = { padding: '24px 32px', maxWidth: 900, margin: '0 auto' }

// A line above the cards, boxed like the demo line.
const NOTE: React.CSSProperties = { fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, padding: '8px 12px', background: color.surfaceSubtle, borderRadius: radius.md, border: `1px solid ${color.borderDefault}` }

/**
 * Each person's own email settings, the same for every role. When an admin turned off email to members (on Config),
 * a line says so and every control is disabled.
 */
export function Notifications() {
  usePageTitle('Notifications')
  const { user } = useAuth()
  const { demoLocked } = useDemo()
  const location = useLocation()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  const { config } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const emailsOn = config?.notificationEmailsEnabled !== false
  const flashed = useSettingFlash(location.hash, SETTING_IDS)

  return (
    <div style={PAGE}>
      <SettingsNav />

      {demoLocked && (
        <div style={NOTE}>
          This is a demo — settings are read-only.
        </div>
      )}

      <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginTop: 0, marginBottom: 16 }}>Notifications</h1>

      {!emailsOn && (
        <div style={NOTE}>
          {emailsOffLine(orgNoun)}
          {isAdmin && <> <Link to="/admin/config" style={{ color: color.linkBlue }}>Turn it back on in Config</Link></>}
        </div>
      )}

      <NotificationCards flashed={flashed} />
    </div>
  )
}
