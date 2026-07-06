import type { CSSProperties } from 'react'
import { color, fontSize } from '../../styles/tokens'
import type { CalendarEvent } from '../../lib/calendarGrid'
import type { BillOption } from '../BillPicker'
import { EventFormFields, type EventFormValues } from './EventFormFields'
import { EventLines } from './EventLines'
import { EventSourceIcon } from './EventSourceIcon'
import { HoverTooltip } from '../HoverTooltip'
import { EVENT_CARD_BASE, eventSourceIcon } from '../../../../shared/eventLineModel'

// ⚠️ Email twin: api/src/lib/weekAheadEmail.ts (renderEventCard) re-implements
// this event card in email HTML. Shared bits flow through eventSourceIcon,
// eventBodyModel and EVENT_SOURCE_TILE; layout/markup here is NOT shared, so
// structural changes won't reach the week-ahead email unless you update it too.
export function EventItem({ event, isPast, isAdmin, editing, flashing, billOptions, onEdit, onEditSave, onEditCancel, onDelete, onRestore }: {
  event: CalendarEvent
  isPast: boolean
  isAdmin: boolean
  editing: boolean
  /** Briefly outline the card when deep-linked from the hearings widget. */
  flashing?: boolean
  billOptions: BillOption[]
  onEdit: (e: CalendarEvent) => void
  onEditSave: (v: EventFormValues) => void
  onEditCancel: () => void
  onDelete: (e: CalendarEvent) => void
  onRestore: (e: CalendarEvent) => void
}) {
  const cancelled = event.status === 'cancelled'
  const isCustom = event.source === 'custom'
  const cardStyle: CSSProperties = {
    ...EVENT_CARD_BASE,
    padding: editing ? 0 : '8px 10px',
    opacity: !editing && (cancelled || isPast) ? 0.55 : 1,
    boxShadow: flashing ? `0 0 0 3px ${color.borderAmber}` : EVENT_CARD_BASE.boxShadow,
    transition: 'box-shadow 0.6s ease',
  }

  const iconBtn: CSSProperties = {
    background: 'none',
    border: 'none',
    color: color.textMuted,
    cursor: 'pointer',
    padding: 2,
    display: 'inline-flex',
    alignItems: 'center',
  }

  const initial: EventFormValues = {
    id: event.id,
    description: event.description ?? '',
    date: event.date ?? '',
    time: event.time,
    location: event.location,
    billIds: event.bills.map(b => b.id),
    details: event.details ?? '',
    url: event.url ?? '',
  }

  return (
    <div id={`agenda-event-${event.id}`} style={cardStyle}>
      {editing ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <EventFormFields
            initial={initial}
            billOptions={billOptions}
            multiState={billOptions.some(b => b.state !== billOptions[0]?.state)}
            onSave={onEditSave}
            onClose={onEditCancel}
            autoFocus={false}
          />
        </div>
      ) : (
        <>
          <HoverTooltip text={eventSourceIcon(event).label} portal>
            <EventSourceIcon event={event} />
          </HoverTooltip>
          <div style={{ flex: 1, minWidth: 0 }}>
            <EventLines event={event} linkChips clampDetails />
          </div>
          {isCustom && isAdmin && (
            <div style={{ display: 'flex', gap: 2, flexShrink: 0, alignSelf: 'center' }}>
              {cancelled
                ? (
                  <HoverTooltip text="Restore event" portal>
                    <button type="button" style={iconBtn} aria-label="Restore event" onClick={() => onRestore(event)}>
                      <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>restore_from_trash</span>
                    </button>
                  </HoverTooltip>
                )
                : (
                  <>
                    <HoverTooltip text="Edit event" portal>
                      <button type="button" style={iconBtn} aria-label="Edit event" onClick={() => onEdit(event)}>
                        <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>edit</span>
                      </button>
                    </HoverTooltip>
                    <HoverTooltip text="Delete event" portal>
                      <button type="button" style={{ ...iconBtn, color: color.textDeleteRed }} aria-label="Delete event" onClick={() => onDelete(event)}>
                        <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>delete</span>
                      </button>
                    </HoverTooltip>
                  </>
                )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
