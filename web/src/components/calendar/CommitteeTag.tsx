import type { CSSProperties } from 'react'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import type { CalendarEvent } from '../../lib/calendarGrid'

/** "Health" for "Committee on Health": how a month cell names a committee in one line. A name that isn't "Committee on/of ..." stays whole. */
export function shortCommitteeName(name: string): string {
  return name === 'Committee of the Whole' ? name : name.trim().replace(/^committee (on|of) (the )?/i, '')
}

/** Height of the committee line a month cell adds above a body event's own lines. */
export const COMMITTEE_LINE_H = 16

const tagText: CSSProperties = { fontSize: fontSize.xs, color: color.textSecondary }
const PRIORITIZED_LABEL = 'Shown: prioritized bill'

/** Whether an event carries something for the tag to say. */
export function hasCommitteeTag(event: CalendarEvent): boolean {
  return !!event.committee || !!event.shownByPriority
}

/**
 * The committee on a body event (#695), the same in the agenda and the month
 * grid. The agenda card shows the committee, "jointly with" another, and the
 * "Shown: prioritized bill" chip under the title. A month cell shows "DC ·
 * Health" on one clipped line, with a flag for the chip, so the bill chips
 * below it keep their place. An event with no committee shows no committee.
 */
export function CommitteeTag({ event, compact = false }: { event: CalendarEvent; compact?: boolean }) {
  const name = event.committee
  const flagged = !!event.shownByPriority
  if (!name && !flagged) return null

  if (compact) {
    const label = name ? `${event.bodyState ? `${event.bodyState} · ` : ''}${shortCommitteeName(name)}` : ''
    return (
      <div style={{ ...tagText, display: 'flex', alignItems: 'center', gap: 3, height: COMMITTEE_LINE_H, flexShrink: 0, fontWeight: fontWeight.semibold, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {label && <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>}
        {flagged && (
          <span role="img" aria-label={PRIORITIZED_LABEL} title={PRIORITIZED_LABEL} className="material-symbols-outlined" style={{ fontSize: fontSize.sm, lineHeight: 1, color: color.textAmberDark, flexShrink: 0 }}>flag</span>
        )}
      </div>
    )
  }

  return (
    <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {name && (
        <span style={{ ...tagText, display: 'inline-flex', alignItems: 'center', gap: 3, fontWeight: fontWeight.medium }}>
          <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: fontSize.base, lineHeight: 1 }}>groups</span>
          <span>{name}</span>
        </span>
      )}
      {name && event.jointWith && <span style={tagText}>jointly with {shortCommitteeName(event.jointWith)}</span>}
      {flagged && (
        <span style={{ ...tagText, background: color.bgAmberPriority, color: color.textAmberDark, borderRadius: radius.pill, padding: '0 6px', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: fontSize.sm, lineHeight: 1 }}>flag</span>
          {PRIORITIZED_LABEL}
        </span>
      )}
    </div>
  )
}
