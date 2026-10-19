import type { GroupingEvent } from '../../../shared/companionGroups'
import { groupingLineText } from '../lib/groupingLine'
import { color, fontSize } from '../styles/tokens'

/**
 * A line in a bill's comment thread where its companion group formed or split,
 * set between the comments posted before and after.
 */
export function GroupingLine({ event }: { event: GroupingEvent }) {
  return (
    <div role="note" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 14px', color: color.textMuted, fontSize: fontSize.sm }}>
      <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: fontSize.lg }}>{event.type === 'grouped' ? 'link' : 'link_off'}</span>
      <span>{groupingLineText(event)}</span>
    </div>
  )
}
