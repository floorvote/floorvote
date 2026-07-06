import type { CSSProperties, Ref, RefObject } from 'react'
import { color, radius } from '../../styles/tokens'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { isPastDate } from '../../lib/calendarGrid'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'
import { EventItem } from './EventItem'
import type { EventPopoverPosition } from './EventPopover'
import { DateLabel } from '../ui/DateLabel'
import { eventDateLabel } from '../../lib/calendarDate'

const PANEL_W = 300
const MARGIN = 8

/**
 * Position a day popover so it *covers* the day cell — it shares the cell's
 * top edge and springs from the cell's top corner. Left-aligned (top-left
 * origin) for most columns; flips to right-aligned (top-right origin) when a
 * left-aligned panel would overflow the right edge of the viewport (the
 * Friday/Saturday columns at the 1100px width). maxHeight is clamped so a
 * bottom-row cell never runs off the bottom of the viewport — the event list
 * scrolls internally instead.
 */
export function computeDayPopoverPosition(
  cellRect: DOMRect,
  opts: { width?: number; alignRight?: boolean; grow?: boolean } = {},
  viewportW: number = typeof window !== 'undefined' ? window.innerWidth : 1024,
  viewportH: number = typeof window !== 'undefined' ? window.innerHeight : 768,
): EventPopoverPosition {
  const width = opts.width ?? PANEL_W
  // Fri/Sat columns force a top-right origin; other columns left-align unless a
  // left-aligned panel would run off the right edge of the viewport.
  const fitsLeft = !opts.alignRight && cellRect.left + width <= viewportW - MARGIN
  const left = fitsLeft
    ? cellRect.left
    : Math.max(MARGIN, cellRect.right - width)
  const hOrigin = fitsLeft ? 'left' : 'right'
  // Share the anchor's top edge. If it sits so low that the panel would run off
  // the bottom, lift it up just enough to keep a usable height on screen.
  const MIN_H = 160
  let top = Math.max(MARGIN, cellRect.top)
  let maxHeight = viewportH - top - 12
  if (maxHeight < MIN_H) {
    maxHeight = Math.min(MIN_H, viewportH - 2 * MARGIN)
    top = Math.max(MARGIN, viewportH - maxHeight - 12)
  }
  maxHeight = Math.min(480, maxHeight)
  // `grow` panels (forms) size to content and never clip, so a combobox dropdown
  // can flow past the edge; read-only popovers cap height and scroll internally.
  const base: CSSProperties = opts.grow
    ? { position: 'fixed', left, top, width, display: 'flex', flexDirection: 'column' }
    : { position: 'fixed', left, top, width, maxHeight, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
  return {
    positionStyle: base,
    transformOrigin: `top ${hOrigin}`,
    // Spring purely from the corner (scale only) so the panel grows out over
    // the cell rather than sliding in from above.
    enterOffsetY: 0,
  }
}

export function DayPopover({ dateIso, events, isAdmin, position, onClose, onEdit, onDelete, onRestore, triggerRef, ref }: {
  dateIso: string
  events: CalendarEvent[]
  isAdmin: boolean
  position: EventPopoverPosition
  onClose: () => void
  onEdit: (e: CalendarEvent) => void
  onDelete: (e: CalendarEvent) => void
  onRestore: (e: CalendarEvent) => void
  triggerRef?: RefObject<HTMLElement | null>
  ref?: Ref<PopPanelHandle>
}) {
  const headerStyle: CSSProperties = {
    padding: '12px 14px 8px',
    borderBottom: `1px solid ${color.borderDefault}`,
    flexShrink: 0,
  }
  const dateLabel = eventDateLabel(dateIso)
  const past = isPastDate(dateIso)

  return (
    <PopPanel
      ref={ref}
      onClose={onClose}
      triggerRef={triggerRef}
      ariaLabel={`Events on ${dateLabel.label}`}
      cornerRadius={radius.md}
      transformOrigin={position.transformOrigin}
      enterOffsetY={position.enterOffsetY}
      positionStyle={position.positionStyle}
    >
      <div style={headerStyle}><DateLabel {...dateLabel} /></div>
      <div style={{ padding: '10px 12px 4px', overflowY: 'auto', minHeight: 0 }}>
        {events.map(ev => (
          <EventItem
            key={ev.id}
            event={ev}
            isPast={past}
            isAdmin={isAdmin}
            editing={false}
            billOptions={[]}
            onEdit={onEdit}
            onEditSave={() => {}}
            onEditCancel={() => {}}
            onDelete={onDelete}
            onRestore={onRestore}
          />
        ))}
      </div>
    </PopPanel>
  )
}
