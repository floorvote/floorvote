import { Link, useNavigate } from 'react-router-dom'
import React, { useState } from 'react'
import { BILL_BADGE_MINI } from '../../lib/chipStyles'
import { billUrl } from '../../lib/sessionSlug'
import { color, fontSize, fontWeight } from '../../styles/tokens'
import { formatHearingTimeShort } from '../../lib/hearingTime'
import { eventDateLabel } from '../../lib/calendarDate'
import { BillBadge } from '../BillBadge'
import { DateLabel } from '../ui/DateLabel'
import { EVENT_TITLE_STYLE, EVENT_META_STYLE } from '../calendar/EventLines'
import type { HearingGroup } from './types'

// How many bill chips to show before collapsing the rest behind "+N more".
const HEARING_CHIP_CAP = 6

const HEARING_MORE_CHIP: React.CSSProperties = {
  ...BILL_BADGE_MINI,
  background: color.surfaceMuted,
  color: color.textSlate500,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

// One hearing in the sidebar widget: a slim date · time header line, the
// hearing name, its location, and the bill chips (capped, expandable).
export function HearingRow({
  hearing, isFirst, onClose,
}: {
  hearing: HearingGroup
  isFirst: boolean
  onClose: () => void
}) {
  const [expanded, setExpanded] = useState(false)
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
    (hearing.bills.length === 1 ? hearing.bills[0].title : 'Hearing')

  const shownBills = expanded ? hearing.bills : hearing.bills.slice(0, HEARING_CHIP_CAP)
  const hiddenCount = hearing.bills.length - shownBills.length

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

      {/* Bill chips (full width; capped with +N more) — own click targets */}
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
              priority={b.priority ?? undefined}
              hoverBill={{ title: b.title, summary: b.summary, priority: b.priority }}
            />
          </Link>
        )})}
        {hiddenCount > 0 && (
          <button onClick={() => setExpanded(true)} style={HEARING_MORE_CHIP}>
            +{hiddenCount} more
          </button>
        )}
        {expanded && hearing.bills.length > HEARING_CHIP_CAP && (
          <button onClick={() => setExpanded(false)} style={HEARING_MORE_CHIP}>
            Show less
          </button>
        )}
      </div>
    </div>
  )
}
