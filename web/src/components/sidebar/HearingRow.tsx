import { Link, useNavigate } from 'react-router-dom'
import { billUrl } from '../../lib/sessionSlug'
import { color, fontSize, fontWeight } from '../../styles/tokens'
import { billDisplayTitle } from '../../../../shared/billTitle'
import { formatHearingTimeShort } from '../../lib/hearingTime'
import { eventDateLabel } from '../../lib/calendarDate'
import { BillBadge } from '../BillBadge'
import { DateLabel } from '../ui/DateLabel'
import { FoldToggle, useFold } from '../Fold'
import { EVENT_TITLE_STYLE, EVENT_META_STYLE } from '../calendar/EventLines'
import type { HearingGroup } from './types'

// How many bill chips to show before collapsing the rest behind "+N more".
const HEARING_CHIP_CAP = 6

// One hearing in the sidebar widget: a slim date · time header line, the
// hearing name, its location, and the bill chips (capped, expandable).
export function HearingRow({
  hearing, isFirst, onClose,
}: {
  hearing: HearingGroup
  isFirst: boolean
  onClose: () => void
}) {
  const fold = useFold()
  const navigate = useNavigate()

  // Clicking the hearing (everything but the bill chips) opens the calendar
  // agenda focused on this hearing, which scrolls to and flashes it.
  const goToAgenda = () => {
    navigate(hearing.eventHash ? `/calendar?focusEvent=${encodeURIComponent(hearing.eventHash)}` : '/calendar')
    onClose()
  }

  const hasValidDate = hearing.date?.split('-').length === 3
  // Match the calendar exactly: short uppercase weekday (amber today), compact time.
  const { label: dateLabel, isToday } = hasValidDate ? eventDateLabel(hearing.date) : { label: '', isToday: false }
  const time = formatHearingTimeShort(hearing.time)
  const name = hearing.description?.trim() || hearing.type?.trim() ||
    (hearing.bills.length === 1 ? billDisplayTitle(hearing.bills[0]) : 'Hearing')

  // Folded, the chips stop at the cap and the toggle counts the rest. The count is of the
  // bills past the cap, whatever is showing, so the label doesn't change while the fold
  // animates shut.
  const shownBills = fold.expanded ? hearing.bills : hearing.bills.slice(0, HEARING_CHIP_CAP)
  const hiddenCount = Math.max(0, hearing.bills.length - HEARING_CHIP_CAP)

  return (
    <div style={{ padding: '8px 10px', borderTop: isFirst ? 'none' : `1px solid ${color.surfaceMuted}` }}>
      {/* Layout mirrors the agenda card: date·time, description, chips, location —
          using the shared event styles so the two never drift. Clicking the
          text (not the chips) opens the agenda on this hearing. */}
      <div
        role="link"
        tabIndex={0}
        onClick={goToAgenda}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToAgenda() } }}
        style={{ cursor: 'pointer' }}
      >
        {/* Date · time line — short uppercase day (amber today), compact time, lighter weight */}
        <div style={{ marginBottom: 3 }}>
          {dateLabel && <DateLabel label={dateLabel} isToday={isToday} />}
          {time && <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.normal, color: color.textMuted }}>{` · ${time}`}</span>}
        </div>

        {/* Description — same style as the agenda card title (sans, not serif) */}
        <div
          style={{
            ...EVENT_TITLE_STYLE,
            lineHeight: 1.3,
            marginBottom: 0,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
          title={name}
        >
          {name}
        </div>
      </div>

      {/* Location — directly under the title, with a pin icon; opens the agenda */}
      {hearing.location && (
        <div
          role="link"
          tabIndex={0}
          onClick={goToAgenda}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToAgenda() } }}
          style={{
            ...EVENT_META_STYLE,
            cursor: 'pointer',
            lineHeight: 1.3,
            marginTop: 4,
            marginBottom: 4,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            overflow: 'hidden',
          }}
          title={hearing.location}
        >
          <span className="material-symbols-outlined" style={{ fontSize: fontSize.sm, lineHeight: 1, flexShrink: 0 }}>location_on</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hearing.location}</span>
        </div>
      )}

      {/* Bill chips (full width; capped with +N more) — own click targets. The clip box
          wraps the chip row so the shared fold animation can resize it. */}
      <div {...fold.clipProps}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
          {shownBills.map(b => {
            const to = `${billUrl({ id: b.id, state: b.state, sessionSlug: b.sessionSlug, billNumber: b.billNumber })}#section-hearings`
            return (
            <Link
              key={b.id}
              to={to}
              onClick={() => onClose()}
              style={{ textDecoration: 'none', cursor: 'pointer' }}
            >
              <BillBadge
                billNumber={b.billNumber}
                state={b.state}
                mini
                isDraft={b.isDraft}
                /* No visible DraftChip here: this is a wrapped chip row capped at
                   six chips in a ~300px sidebar column, and a ~50px chip beside
                   every draft badge would push the row to wrap at a fraction of
                   the bills it holds today. The text signal is the badge's own
                   screen-reader label instead. */
                draftSrLabel
                priority={b.priority ?? undefined}
                hoverBill={{ title: b.title, isDraft: b.isDraft, summary: b.summary, priority: b.priority }}
              />
            </Link>
          )})}
        </div>
      </div>
      {hiddenCount > 0 && <FoldToggle open={fold.open} count={hiddenCount} onToggle={fold.toggle} controls={fold.clipProps.id} />}
    </div>
  )
}
