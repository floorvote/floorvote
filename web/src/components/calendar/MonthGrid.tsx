import { useState } from 'react'
import type { CSSProperties } from 'react'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { buildMonthMatrix, bucketEventsByDate, isPastDate, todayIso, type CalendarEvent } from '../../lib/calendarGrid'
import { EventLines } from './EventLines'
import { useIsBreakpoint } from '../../hooks/use-is-breakpoint'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// Up to two cards per cell, each ~half the cell height; the rest fold into "+N more".
// ROW_H is near the floor that still fits two CARD_H cards plus the "+N more" row.
const CELL_CAP = 2
const ROW_H = 138
const CARD_H = 46

export function MonthGrid({ events, initialYear, initialMonth, onSelect, onSelectDay, onAddEvent, suppressHover, activeDateIso }: {
  events: CalendarEvent[]
  initialYear: number
  initialMonth: number // 0-indexed
  /** `alignRight` is true for the Fri/Sat columns so popovers spring from the
   *  cell's top-right corner (toward the grid) instead of overflowing right. */
  onSelect: (e: CalendarEvent, anchor: HTMLElement, alignRight: boolean) => void
  /** Open the day-detail popover (covers the cell) when "+N more" is clicked. */
  onSelectDay?: (dateIso: string, dayEvents: CalendarEvent[], cellEl: HTMLElement, alignRight: boolean) => void
  /** Click an (in-month) day to add an event there. `anchor` is the slot the new
   *  card would occupy; `cellEl` is the day cell element (for calendar-bounds
   *  clamping). The form pops over that slot. */
  onAddEvent?: (dateIso: string, anchor: DOMRect, cellEl: HTMLElement, alignRight: boolean) => void
  suppressHover?: boolean
  /** The day whose popover/form is currently open — gets a 2px amber outline. */
  activeDateIso?: string | null
}) {
  const [{ year, month }, setYm] = useState({ year: initialYear, month: initialMonth })
  const weeks = buildMonthMatrix(year, month)
  const byDate = bucketEventsByDate(events)
  const today = todayIso()
  // On phones the fixed-height rows of a 7-column grid produce tiny columns with
  // huge empty cells. Let rows auto-size instead so empty days collapse and only
  // days with events grow — a compact month overview that fits the viewport.
  const isMobile = useIsBreakpoint('max', 768)
  const cap = CELL_CAP
  const dowLabels = isMobile ? DOW_SHORT : DOW

  const step = (delta: number) => {
    const d = new Date(year, month + delta, 1)
    setYm({ year: d.getFullYear(), month: d.getMonth() })
  }

  const navBtn = { background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, cursor: 'pointer', padding: '4px 10px', fontSize: fontSize.sm }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: fontSize.base, fontWeight: fontWeight.semibold }}>{MONTHS[month]} {year}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" aria-label="Previous month" onClick={() => step(-1)} style={navBtn}>‹</button>
          <button type="button" aria-label="Today" onClick={() => { const n = new Date(); setYm({ year: n.getFullYear(), month: n.getMonth() }) }} style={navBtn}>Today</button>
          <button type="button" aria-label="Next month" onClick={() => step(1)} style={navBtn}>›</button>
        </div>
      </div>
      <div data-calgrid style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
        ...(isMobile
          ? { gridAutoRows: 'minmax(44px, auto)', gap: 2 }
          : { gridTemplateRows: `auto repeat(6, ${ROW_H}px)`, gap: 4 }),
      }}>
        {dowLabels.map((d, i) => (
          <div key={i} style={{ fontSize: fontSize.xs, color: color.textMuted, textTransform: 'uppercase', textAlign: 'center', padding: '2px 0' }}>{d}</div>
        ))}
        {weeks.flat().map((cell, i) => {
          const dayEvents = byDate.get(cell.iso) ?? []
          const shown = dayEvents.slice(0, cap)
          const hidden = dayEvents.length - shown.length
          const past = isPastDate(cell.iso, today)
          const dow = i % 7 // 0 = Sun … 6 = Sat (grid is Sunday-first)
          const isWeekend = dow === 0 || dow === 6
          // Fri/Sat columns spring the day popover from the top-right corner.
          const alignRight = dow >= 5
          // Today is filled with the pale amber highlight (reused app-wide);
          // it overrides the weekend/out-of-month fill.
          const cellBg = cell.iso === today
            ? color.bgAmberPriority
            : cell.inMonth ? (isWeekend ? color.surfaceSubtle : color.white) : color.surfaceMuted
          // The day whose popover/form is open gets a 2px amber outline.
          const isActive = !!activeDateIso && cell.iso === activeDateIso
          const addable = !!onAddEvent && cell.inMonth
          return (
            <div
              key={cell.iso}
              data-daycell={cell.iso}
              data-inmonth={cell.inMonth ? 1 : 0}
              onClick={addable ? (e => onAddEvent!(cell.iso, addAnchorRect(e.currentTarget), e.currentTarget, alignRight)) : undefined}
              style={{
                padding: 6, borderRadius: radius.md, minWidth: 0, overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
                background: cellBg,
                border: `${isActive ? 2 : 1}px solid ${isActive ? color.accentAmber : color.borderDefault}`,
                opacity: cell.inMonth ? 1 : 0.55,
                cursor: addable ? 'pointer' : 'default',
              }}
            >
              <div style={{ fontSize: fontSize.xs, color: color.textMuted, marginBottom: 3, flexShrink: 0 }}>{cell.day}</div>
              <div data-events style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'hidden' }}>
                {shown.map(ev => (
                  <EventCard
                    key={ev.id}
                    ev={ev}
                    past={past}
                    fixedHeight={!isMobile}
                    suppressHover={suppressHover}
                    alignRight={alignRight}
                    onSelect={onSelect}
                  />
                ))}
              </div>
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation() // don't also trigger the cell's "new event"
                    const cellEl = (e.currentTarget.closest('[data-daycell]') as HTMLElement) ?? e.currentTarget
                    onSelectDay?.(cell.iso, dayEvents, cellEl, alignRight)
                  }}
                  style={{
                    flexShrink: 0, marginTop: 2, alignSelf: 'flex-start', background: 'none', border: 'none',
                    cursor: 'pointer', font: 'inherit', fontSize: fontSize.xs, fontWeight: fontWeight.semibold,
                    color: color.textSlate, padding: '1px 2px',
                  }}
                >
                  +{hidden} more
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function EventCard({ ev, past, fixedHeight, suppressHover, alignRight, onSelect }: {
  ev: CalendarEvent
  past: boolean
  fixedHeight: boolean
  suppressHover?: boolean
  alignRight: boolean
  onSelect: (e: CalendarEvent, anchor: HTMLElement, alignRight: boolean) => void
}) {
  const cardStyle: CSSProperties = {
    width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit',
    padding: '3px 6px', borderRadius: radius.md,
    border: `1px solid ${color.borderDefault}`,
    background: color.white, color: color.textSlate,
    opacity: past ? 0.55 : 1, overflow: 'hidden',
    display: 'flex', flexDirection: 'column', gap: 2,
    ...(fixedHeight ? { height: CARD_H, flexShrink: 0 } : {}),
  }

  return (
    <button type="button" onClick={e => { e.stopPropagation(); onSelect(ev, e.currentTarget, alignRight) }} style={cardStyle}>
      <EventLines event={ev} compact suppressHover={suppressHover} />
    </button>
  )
}

// The slot a new event would occupy in this cell: below the last event card, or
// at the top of the events area (under the day number) when the day is empty.
// The New-event form pops over this slot. Zero-height — only top/left/right matter.
function addAnchorRect(cellEl: HTMLElement): DOMRect {
  const eventsEl = cellEl.querySelector('[data-events]') as HTMLElement | null
  const box = (eventsEl ?? cellEl).getBoundingClientRect() // content-box edge = where cards sit
  const cards = eventsEl ? Array.from(eventsEl.children) : []
  const top = cards.length
    ? cards[cards.length - 1].getBoundingClientRect().bottom + 4
    : box.top
  return new DOMRect(box.left, top, box.width, 0)
}
