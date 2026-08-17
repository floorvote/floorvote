import type { CSSProperties, Ref, RefObject } from 'react'
import { color, fontSize, radius } from '../../styles/tokens'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'
import { DateLabel } from '../ui/DateLabel'
import { eventDateLabel } from '../../lib/calendarDate'
import { EventLines } from './EventLines'
import { EventSourceIcon } from './EventSourceIcon'
import { eventSourceIcon } from '../../../../shared/eventLineModel'
import { HoverTooltip } from '../HoverTooltip'
import type { Box } from './expandTarget'
import { useDemo } from '../../context/DemoContext'

export interface EventPopoverPosition {
  positionStyle: CSSProperties
  transformOrigin: string
  enterOffsetY: number
}

const PANEL_W = 300
const EST_H = 150 // rough popover height; only biases the drop-down vs pop-up choice

export interface PopoverPlacement {
  /** Panel width in px (default 300). Used for the right-edge clamp. */
  width?: number
  /** Horizontal anchoring: 'left' aligns the panel's left edge to the trigger's
   *  left (springs down-right); 'right' aligns the panel's right edge to the
   *  trigger's right (springs down-left). Default 'left'. */
  align?: 'left' | 'right'
  /** When true, the panel sizes to its content (no maxHeight, no overflow clip)
   *  so children like a combobox dropdown can flow past the panel edge. */
  grow?: boolean
}

export function computeEventPopoverPosition(
  rect: DOMRect,
  opts: PopoverPlacement = {},
  viewportW: number = typeof window !== 'undefined' ? window.innerWidth : 1024,
  viewportH: number = typeof window !== 'undefined' ? window.innerHeight : 768,
): EventPopoverPosition {
  const width = opts.width ?? PANEL_W
  const align = opts.align ?? 'left'
  const rawLeft = align === 'right' ? rect.right - width : rect.left
  const left = Math.max(8, Math.min(rawLeft, viewportW - width - 8))
  const hOrigin = align === 'right' ? 'right' : 'left'
  const base: CSSProperties = opts.grow
    ? { position: 'fixed', left, width, display: 'flex', flexDirection: 'column' }
    : { position: 'fixed', left, width, maxHeight: 'min(70vh, 360px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
  if (rect.bottom + 6 + EST_H <= viewportH) {
    return { positionStyle: { ...base, top: rect.bottom + 6 }, transformOrigin: `top ${hOrigin}`, enterOffsetY: -6 }
  }
  return { positionStyle: { ...base, bottom: viewportH - rect.top + 6 }, transformOrigin: `bottom ${hOrigin}`, enterOffsetY: 6 }
}

export function EventPopoverContent({ event, isAdmin, expanded = false, onEdit, onDelete, onRestore }: {
  event: CalendarEvent
  isAdmin: boolean
  expanded?: boolean
  onEdit: (e: CalendarEvent) => void
  onDelete: (e: CalendarEvent) => void
  onRestore: (e: CalendarEvent) => void
}) {
  const { demoLocked } = useDemo()
  const canManage = isAdmin && event.source === 'custom'
  const iconBtn = {
    background: 'none', border: 'none', color: color.textMuted, cursor: 'pointer',
    padding: 2, display: 'inline-flex', alignItems: 'center',
  } as const
  const dateBlock = event.date ? <DateLabel {...eventDateLabel(event.date)} /> : null

  return (
    <div data-event-detail style={{ padding: expanded ? 0 : 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <HoverTooltip text={eventSourceIcon(event).label}>
          <EventSourceIcon event={event} />
        </HoverTooltip>
        <div style={{ flex: 1, minWidth: 0 }}>
          {dateBlock && <div style={{ marginBottom: 6 }}>{dateBlock}</div>}
          <EventLines event={event} linkChips />
        </div>
        {canManage && (
          <div style={{ display: 'flex', gap: 2, alignItems: 'center', flexShrink: 0 }}>
            {event.status !== 'cancelled' && (
              <HoverTooltip text="Edit event">
                <button type="button" onClick={() => onEdit(event)} style={iconBtn} aria-label="Edit event">
                  <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>edit</span>
                </button>
              </HoverTooltip>
            )}
            {event.status !== 'cancelled' && (
              <HoverTooltip text="Delete event">
                <button
                  type="button"
                  disabled={demoLocked}
                  onClick={() => onDelete(event)}
                  style={{ ...iconBtn, color: demoLocked ? color.borderStrong : color.textErrorRed, ...(demoLocked ? { cursor: 'not-allowed' } : null) }}
                  aria-label="Delete event"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>delete</span>
                </button>
              </HoverTooltip>
            )}
            {event.status === 'cancelled' && (
              <HoverTooltip text="Restore event">
                <button
                  type="button"
                  disabled={demoLocked}
                  onClick={() => onRestore(event)}
                  style={{ ...iconBtn, ...(demoLocked ? { color: color.borderStrong, cursor: 'not-allowed' } : null) }}
                  aria-label="Restore event"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>restore_from_trash</span>
                </button>
              </HoverTooltip>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function EventPopover({ event, isAdmin, onEdit, onDelete, onRestore, onClose, position, triggerRef, expandFrom, computeTarget, ref }: {
  event: CalendarEvent
  isAdmin: boolean
  onEdit: (e: CalendarEvent) => void
  onDelete: (e: CalendarEvent) => void
  onRestore: (e: CalendarEvent) => void
  onClose: () => void
  position: EventPopoverPosition
  triggerRef?: RefObject<HTMLElement | null>
  /** When set, render as an in-place expansion from this card rect. */
  expandFrom?: DOMRect
  computeTarget?: (naturalHeight: number) => Box
  ref?: Ref<PopPanelHandle>
}) {
  const expanded = !!(expandFrom && computeTarget)
  const tint = event.source === 'custom' ? color.bgInfo : color.bgInfo
  return (
    <PopPanel
      ref={ref}
      onClose={onClose}
      triggerRef={triggerRef}
      ariaLabel="Event details"
      cornerRadius={radius.md}
      transformOrigin={position.transformOrigin}
      enterOffsetY={position.enterOffsetY}
      positionStyle={position.positionStyle}
      expandFrom={expandFrom}
      computeTarget={computeTarget}
      background={expanded ? tint : undefined}
    >
      <EventPopoverContent event={event} isAdmin={isAdmin} expanded={expanded} onEdit={onEdit} onDelete={onDelete} onRestore={onRestore} />
    </PopPanel>
  )
}
