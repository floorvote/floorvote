import { useState, type CSSProperties } from 'react'
import { color, fontSize } from '../../styles/tokens'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { BillBadge } from '../BillBadge'
import { billUrl } from '../../lib/sessionSlug'
import {
  EVENT_TITLE_STYLE, EVENT_META_STYLE,
  type EventBodyModel, eventBodyModel, formatEventUrl,
} from '../../../../shared/eventLineModel'
import { EventSourceIcon } from './EventSourceIcon'

export { EVENT_TITLE_STYLE, EVENT_META_STYLE, type EventBodyModel, eventBodyModel }

const META_ICON_STYLE: CSSProperties = { fontSize: fontSize.sm, lineHeight: 1 }

/**
 * The shared body for an event across the month cell, agenda card, and popover.
 *
 * Compact (month cell): one clipped line — "9a · <description | location | bill
 * title>" — plus a clipped chip row; location/details fold into the line-clamp.
 *
 * Full (agenda card, popover): a stacked, icon-labeled block —
 *   title / 🕐 time / 📍 location / 🔗 link / bill chips / details
 * `linkChips` makes the chips deep-link to the bill (agenda/popover); off in the
 * month cell where the whole card is the click target.
 */
export function EventLines({ event, compact = false, linkChips = false, suppressHover = false, clampDetails = false }: {
  event: CalendarEvent
  compact?: boolean
  linkChips?: boolean
  suppressHover?: boolean
  clampDetails?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const { time, text, location, cancelled } = eventBodyModel(event, compact)
  // In the compact month cell with no bills, all content (title + location +
  // description) merges into one -webkit-line-clamp:3 block so the clamp
  // counts across all three together. Location is only shown separately when
  // the title comes from description — if location was promoted to title text
  // (no description), showing it again would duplicate it.
  const compactLocationHint = compact && event.bills.length === 0 && !!event.description?.trim()
    ? (event.location?.trim() || null)
    : null
  const compactDetailsHint = compact && event.bills.length === 0
    ? (event.details?.trim() || null)
    : null
  const isCompactNoBills = compact && event.bills.length === 0
  const lineFont = compact ? fontSize.xs : fontSize.sm
  const showToggle = !!event.details && (event.details.includes('\n') || event.details.length > 80)
  const detailStyle: CSSProperties = {
    ...EVENT_META_STYLE, marginTop: 4, whiteSpace: 'pre-line', lineHeight: 1.5,
    ...(clampDetails && !showAll ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } as CSSProperties : {}),
  }
  const cancelStyle: CSSProperties = cancelled ? { color: color.textMuted, textDecoration: 'line-through' } : {}

  const billChips = (wrap: boolean) => (
    <div style={{
      display: 'flex', gap: 3, marginTop: 3,
      ...(wrap ? { flexWrap: 'wrap' } : { flexWrap: 'nowrap', overflow: 'hidden' }),
    }}>
      {event.bills.map(b => {
        const to = linkChips ? billUrl({ id: b.id, state: b.state, billNumber: b.billNumber }) : undefined
        return (
          <BillBadge
            key={b.id}
            billNumber={b.billNumber}
            state={b.state}
            mini
            priority={b.priority ?? undefined}
            to={to}
            hoverBill={suppressHover ? undefined : { billId: b.id, title: b.billTitle, summary: null, priority: b.priority }}
          />
        )
      })}
    </div>
  )

  if (isCompactNoBills) {
    // Compact month cell, no bills: single line-clamped block so the 3-line
    // budget is shared across title + location + description.
    return (
      <div style={{
        fontSize: lineFont, flexShrink: 0,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      } as CSSProperties}>
        <EventSourceIcon event={event} compact />
        {time && <span style={{ color: color.textMuted }}>{time}{text ? ' · ' : ''}</span>}
        <span style={{ ...EVENT_TITLE_STYLE, fontSize: lineFont, ...cancelStyle }}>{text}</span>
        {compactLocationHint && (
          <><br /><span style={EVENT_META_STYLE}>
            <span className="material-symbols-outlined" style={{ fontSize: fontSize.sm, verticalAlign: 'middle' }}>location_on</span>
            {' '}{compactLocationHint}
          </span></>
        )}
        {compactDetailsHint && (
          <><br /><span style={EVENT_META_STYLE}>{compactDetailsHint}</span></>
        )}
      </div>
    )
  }

  if (compact) {
    // Compact month cell with bills: one clipped title line + one clipped chip row.
    return (
      <>
        {(time || text) && (
          <div style={{ fontSize: lineFont, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <EventSourceIcon event={event} compact />
            {time && <span style={{ color: color.textMuted }}>{time}</span>}
            {time && text && <span style={{ color: color.textMuted }}>{' · '}</span>}
            {text && <span style={{ ...EVENT_TITLE_STYLE, fontSize: lineFont, ...cancelStyle }}>{text}</span>}
          </div>
        )}
        {event.bills.length > 0 && billChips(false)}
      </>
    )
  }

  // Full variant (agenda card, day popover): stacked, icon-labeled lines.
  return (
    <>
      {text && (
        <div style={{ ...EVENT_TITLE_STYLE, fontSize: lineFont, ...cancelStyle }}>{text}</div>
      )}
      {time && (
        <div style={{ ...EVENT_META_STYLE, marginTop: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
          <span className="material-symbols-outlined" style={META_ICON_STYLE}>schedule</span>
          {time}
        </div>
      )}
      {location && (
        <div style={{ ...EVENT_META_STYLE, marginTop: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
          <span className="material-symbols-outlined" style={META_ICON_STYLE}>location_on</span>
          {location}
        </div>
      )}
      {event.url && (
        <div style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
          <span className="material-symbols-outlined" style={{ ...META_ICON_STYLE, color: color.textMuted }}>link_2</span>
          <a
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: fontSize.xs, color: color.accentBlue, textDecoration: 'underline', overflowWrap: 'anywhere' }}
          >
            {formatEventUrl(event.url)}
          </a>
        </div>
      )}
      {event.bills.length > 0 && billChips(true)}
      {event.details && (
        <>
          <div style={detailStyle}>{event.details}</div>
          {clampDetails && showToggle && (
            <button
              type="button"
              onClick={() => setShowAll(v => !v)}
              style={{ marginTop: 2, padding: 0, border: 'none', background: 'none', cursor: 'pointer', fontSize: fontSize.xs, color: color.accentBlue }}
            >
              {showAll ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
    </>
  )
}
