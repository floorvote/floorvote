import type { CSSProperties, ReactNode } from 'react'
import { userEventIcon, type UserEventIcon } from '../../../shared/billCardModel'
import type { FieldChangeEvent } from '../../../shared/teamFields'
import { dbTsToEpoch } from '../../../shared/time'
import { fieldChangeText } from '../lib/activityLine'
import { formatShortMonthDay } from '../lib/calendarDate'
import type { ThreadLine } from '../lib/groupingLine'
import { color, fontSize, fontWeight } from '../styles/tokens'
import { GroupingLine, THREAD_LINE_STYLE } from './GroupingLine'
import { PrioritySquare } from './PrioritySquare'

type Options = {
  /** What the page calls the position, in a sentence about it ("association position"). */
  positionLabel?: string
  /** Something to show after a change's date, such as the badge of the companion bill it was made on. */
  renderBill?: (event: FieldChangeEvent) => ReactNode
}

// The feed's and the digest's own rules for the icon a person's change shows with: priority is a square in the
// priority's color, a position is a glyph in the position's color, and a custom field has the table's one entry.
const ICON_TYPE: Record<FieldChangeEvent['field'], string> = {
  priority: 'priority_set',
  position: 'position_set',
  customField: 'custom_field_set',
}

/** The metadata `userEventIcon` reads for a change: the value it left the field with, when that picks a color. */
function iconMetadata(event: FieldChangeEvent): Record<string, unknown> {
  return event.field === 'priority' ? { priority: event.new } : event.field === 'position' ? { position: event.new } : {}
}

function ChangeIcon({ icon }: { icon: UserEventIcon }) {
  // A priority square sits at the glyph's size, so the line's text keeps its place.
  if (icon.square) return <PrioritySquare size={11} color={icon.color} style={{ marginInline: 3.5 }} data-testid="priority-square" />
  return (
    <span
      className="material-symbols-outlined"
      aria-hidden="true"
      style={{ fontSize: fontSize.lg, color: icon.color, fontVariationSettings: `'FILL' ${icon.fill}, 'wght' 400, 'GRAD' 0, 'opsz' 24` }}
    >{icon.name}</span>
  )
}

/**
 * A line in a bill's comment thread for one change a person made to a team
 * field, set between the comments posted before and after: a muted note with
 * the icon the feed gives the change, who changed what, and the date.
 */
export function ActivityLine({ event, positionLabel, renderBill, style }: { event: FieldChangeEvent; style?: CSSProperties } & Options) {
  const date = formatShortMonthDay(event.createdAt)
  const bill = renderBill?.(event)
  // The sentence opens with who made the change, set in the heavier weight a comment's author name has.
  const who = event.actorName
  const sentence = fieldChangeText(event, { positionLabel })
  return (
    <div role="note" style={{ ...THREAD_LINE_STYLE, ...style }}>
      <ChangeIcon icon={userEventIcon(ICON_TYPE[event.field], iconMetadata(event))} />
      <span>
        {sentence.startsWith(who)
          ? <><span style={{ fontWeight: fontWeight.semibold, color: color.textSecondary }}>{who}</span>{sentence.slice(who.length)}</>
          : sentence}
        {date && <><span aria-hidden="true"> · </span><time dateTime={new Date(dbTsToEpoch(event.createdAt)).toISOString()}>{date}</time></>}
        {bill && <span style={{ marginLeft: 6 }}>{bill}</span>}
      </span>
    </div>
  )
}

/** One line of a comment thread's activity, whichever kind it is. */
export function ThreadLineView({ line, positionLabel, renderBill }: { line: ThreadLine } & Options) {
  if (line.kind === 'grouping') return <GroupingLine event={line.event} />
  return <ActivityLine event={line.event} positionLabel={positionLabel} renderBill={renderBill} />
}
