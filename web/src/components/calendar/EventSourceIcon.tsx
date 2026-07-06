import { fontSize } from '../../styles/tokens'
import { eventSourceIcon, EVENT_SOURCE_TILE, type EventEdgeSource } from '../../../../shared/eventLineModel'

/**
 * Leading source marker for a calendar event. `compact` (month grid) renders a
 * bare 12px inline glyph — the size of the location icon — so it fits the tight
 * `time · title` line. The default renders a 22px tinted tile for the agenda
 * card and event popover.
 */
export function EventSourceIcon({ event, compact = false }: { event: EventEdgeSource; compact?: boolean }) {
  const { icon, color: iconColor, tint, label: ariaLabel } = eventSourceIcon(event)

  if (compact) {
    return (
      <span
        className="material-symbols-outlined"
        role="img"
        aria-label={ariaLabel}
        style={{ fontSize: fontSize.sm, color: iconColor, verticalAlign: 'middle', marginRight: 3, lineHeight: 1, flexShrink: 0 }}
      >
        {icon}
      </span>
    )
  }
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      style={{
        flexShrink: 0, width: EVENT_SOURCE_TILE.size, height: EVENT_SOURCE_TILE.size, borderRadius: EVENT_SOURCE_TILE.radius,
        background: tint, color: iconColor, marginTop: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: fontSize.base, lineHeight: 1 }}>{icon}</span>
    </span>
  )
}
