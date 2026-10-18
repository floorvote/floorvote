import { Link } from 'react-router-dom'
import { color, fontSize, radius } from '../../styles/tokens'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE } from '../../lib/textStyles'
import { useConfig } from '../../context/ConfigContext'
import { useBodyEventsName, useHasBodyEvents } from '../../lib/capabilities'
import { SettingsNav } from '../../components/SettingsNav'

const PAGE: React.CSSProperties = { padding: '24px 32px', maxWidth: 900, margin: '0 auto' }

/**
 * The old Settings → Calendar events page (#298), now one line (#420): which
 * committee events show is chosen with the control on the Calendar page. The
 * tab is gone, and this page stays so an old link or bookmark still says where
 * the choice went.
 */
export function CalendarEventsMoved() {
  const { loading } = useConfig()
  const hasBodyEvents = useHasBodyEvents()
  const body = useBodyEventsName()
  return (
    <div style={PAGE}>
      <SettingsNav />
      <div style={{ ...CARD, padding: 24, borderRadius: radius.lg }}>
        <h1 style={CARD_TITLE}>Calendar events</h1>
        {!loading && !hasBodyEvents ? (
          <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6 }}>
            None of the states you cover has a legislative calendar FloorVote reads, so there's nothing to choose here.
          </div>
        ) : (
          <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6 }}>
            Which {body} events show is now chosen on the <Link to="/calendar" className="blue-link">Calendar page</Link>.
          </div>
        )}
      </div>
    </div>
  )
}
