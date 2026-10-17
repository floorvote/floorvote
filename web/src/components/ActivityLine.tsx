import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import type { FieldChangeEvent } from '../../../shared/teamFields'
import { dbTsToEpoch } from '../../../shared/time'
import { fieldChangeText, foldText } from '../lib/activityLine'
import { formatShortMonthDay } from '../lib/calendarDate'
import type { ThreadLine } from '../lib/groupingLine'
import { color, fontSize, fontWeight } from '../styles/tokens'
import { GroupingLine, THREAD_LINE_STYLE } from './GroupingLine'

type Options = {
  /** What the page calls the position, in a sentence about it ("association position"). */
  positionLabel?: string
  /** Something to show after a change's date, such as the badge of the companion bill it was made on. */
  renderBill?: (event: FieldChangeEvent) => ReactNode
}

const FIELD_ICONS: Record<FieldChangeEvent['field'], string> = {
  priority: 'flag',
  position: 'thumbs_up_down',
  customField: 'edit_note',
  tags: 'list',
}

const Icon = ({ name }: { name: string }) => (
  <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: fontSize.lg }}>{name}</span>
)

/**
 * A line in a bill's comment thread for one change to a team field, set
 * between the comments posted before and after: a muted note with the field's
 * icon, who changed what, and the date.
 */
export function ActivityLine({ event, positionLabel, renderBill, style }: { event: FieldChangeEvent; style?: CSSProperties } & Options) {
  const date = formatShortMonthDay(event.createdAt)
  const bill = renderBill?.(event)
  // The sentence opens with who made the change, set in the heavier weight a comment's author name has.
  const who = event.actorName ?? 'FloorVote'
  const sentence = fieldChangeText(event, { positionLabel })
  return (
    <div role="note" style={{ ...THREAD_LINE_STYLE, ...style }}>
      <Icon name={FIELD_ICONS[event.field] ?? 'edit_note'} />
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

/**
 * Several consecutive changes by one person, folded into one line that opens in
 * place to show each as its own line. A button, so the keyboard and a screen
 * reader open it, with its state in `aria-expanded`.
 */
export function ActivityFold({ actorName, events, positionLabel, renderBill }: { actorName: string | null; events: FieldChangeEvent[] } & Options) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(o => !o)}
        style={{ ...THREAD_LINE_STYLE, margin: open ? '0 0 8px' : THREAD_LINE_STYLE.margin, padding: 0, border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', fontSize: fontSize.sm, textAlign: 'left' }}
      >
        <Icon name="edit_note" />
        <span>{foldText(actorName, events.length)}</span>
        <span aria-hidden="true" style={{ color: color.textMuted }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul id={listId} style={{ listStyle: 'none', margin: 0, padding: '0 0 0 4px' }}>
          {events.map(event => (
            <li key={event.id}><ActivityLine event={event} positionLabel={positionLabel} renderBill={renderBill} /></li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One line of a comment thread's activity, whichever kind it is. */
export function ThreadLineView({ line, positionLabel, renderBill }: { line: ThreadLine } & Options) {
  if (line.kind === 'grouping') return <GroupingLine event={line.event} />
  if (line.kind === 'change') return <ActivityLine event={line.event} positionLabel={positionLabel} renderBill={renderBill} />
  return <ActivityFold actorName={line.actorName} events={line.events} positionLabel={positionLabel} renderBill={renderBill} />
}
