import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useConfig } from '../context/ConfigContext'
import { useDemo } from '../context/DemoContext'
import { DEFAULT_ORG_NOUN } from '../lib/orgNoun'
import { SettingsNav } from '../components/SettingsNav'
import { usePageTitle } from '../hooks/usePageTitle'
import { LINK_BUTTON } from '../lib/textStyles'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { TeamNotifications } from './notifications/TeamNotifications'
import { YourNotifications } from './notifications/YourNotifications'
import { useSettingFlash } from './notifications/useSettingFlash'
import { useTeamSettings } from './notifications/useTeamSettings'

// The anchors the email footers and List-Unsubscribe headers link to.
const SETTING_IDS = ['setting-email-digest', 'setting-saved-views', 'setting-week-ahead', 'setting-email-replies'] as const

const PAGE: React.CSSProperties = { padding: '24px 32px', maxWidth: 900, margin: '0 auto' }

/**
 * Every notification setting, on one page. Admins and owners see "For everyone on your
 * team" first; everyone sees "Your notifications", with the same emails in the same order.
 */
export function Notifications() {
  usePageTitle('Notifications')
  const { user } = useAuth()
  const { demoLocked } = useDemo()
  const location = useLocation()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  const team = useTeamSettings()
  const { config } = useConfig()
  const orgNoun = config?.orgNoun ?? DEFAULT_ORG_NOUN
  const flashed = useSettingFlash(location.hash, SETTING_IDS)

  return (
    <div style={PAGE}>
      <SettingsNav />

      {demoLocked && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, padding: '8px 12px', background: color.surfaceSubtle, borderRadius: radius.md, border: `1px solid ${color.borderDefault}` }}>
          This is a demo — settings are read-only.
        </div>
      )}

      <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, marginTop: 0, marginBottom: 16 }}>Notifications</h1>

      {team.loadFailed && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, fontSize: fontSize.sm, color: color.textErrorRed }}>
          Couldn't load your {orgNoun}'s settings.
          <button type="button" onClick={team.retryLoad} style={LINK_BUTTON}>Retry</button>
        </div>
      )}

      {isAdmin && !team.loadFailed && <TeamNotifications team={team} />}
      <YourNotifications team={team} flashed={flashed} />
    </div>
  )
}
