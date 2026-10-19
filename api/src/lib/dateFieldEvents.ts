import { and, eq, gte, lte } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { bills, billCustomFieldValues, customFieldDefinitions } from '../db/schema'
import { prioritizedDateFieldValue } from './calendarVisibility'
import { isCalendarDate } from './customFieldValues'
import { loadGroupPriorities, priorityWorn, type BillsTable } from './teamFields'
import { billDisplayTitle } from '../../../shared/billTitle'
import type { AppDb } from '../types'

/**
 * Date custom fields as team calendar events (#342). A date value lives on the
 * bill's custom field value, which can be edited or cleared at any moment (the
 * bill page, bulk edits, the demo reset), so these events are never stored:
 * every reader asks here and merges the result into the events it returns.
 * Which values qualify is `prioritizedDateFieldValue`, so the calendar, the
 * feed, the dashboard count, and the week-ahead email always agree. A value is
 * a group's (#376), so a companion group projects its current value once, linked to
 * the member holding it and keyed by the group, wearing the group's priority (#639).
 */

export interface DateFieldEvent {
  /** `cf-{fieldId}-{billId}` for a bill in no group, `cf-{fieldId}-group-{groupKey}` for a grouped one: from the field and the bill or group, never the date or the member holding the value, so a changed date or a value moving to another member moves the same event. Also the feed UID. */
  id: string
  fieldName: string
  /** YYYY-MM-DD, as stored. */
  date: string
  /** The event's title: `{field name}: {bill number}`. */
  title: string
  /** Increases with every edit of the value (see dateFieldSequence). */
  sequence: number
  bill: {
    id: string; billNumber: string; billTitle: string; state: string | null
    session: string | null; sessionSlug: string | null
    priority: 'high' | 'medium' | 'low' | null; isDraft: boolean
  }
}

/** The feed sequence of an event with no stored row: whole minutes from 2020-01-01 UTC to when its value last changed. Rises with every edit, and stays well inside 32 bits until the year 6000. */
const SEQUENCE_EPOCH = Date.UTC(2020, 0, 1)

export function dateFieldSequence(valueUpdatedAt: string): number {
  // The column holds SQLite's `datetime('now')`: UTC, space-separated, no zone.
  const changed = Date.parse(`${valueUpdatedAt.replace(' ', 'T')}Z`)
  return Number.isFinite(changed) ? Math.max(0, Math.floor((changed - SEQUENCE_EPOCH) / 60_000)) : 0
}

/**
 * The date-field events with a date in [from, to], both inclusive YYYY-MM-DD.
 * A value that isn't a real YYYY-MM-DD date is left out rather than sent as a
 * broken event, since the server stores free text.
 */
export async function loadDateFieldEvents(db: AppDb, { from, to }: { from: string; to: string }): Promise<DateFieldEvent[]> {
  // `p` and `me` are the aliases `prioritizedDateFieldValue` expects.
  const p = alias(billCustomFieldValues, 'p')
  const me = alias(bills, 'me') as unknown as BillsTable
  const rows = await db
    .select({
      fieldId: customFieldDefinitions.id, fieldName: customFieldDefinitions.name,
      value: p.value, updatedAt: p.updatedAt,
      billId: me.id, billNumber: me.billNumber, billTitle: me.title, state: me.state,
      session: me.session, sessionSlug: me.sessionSlug, priority: me.priority, groupKey: me.groupKey, isDraft: me.isDraft,
    })
    .from(p)
    .innerJoin(customFieldDefinitions, eq(p.fieldId, customFieldDefinitions.id))
    .innerJoin(me, eq(p.billId, me.id))
    .where(and(
      prioritizedDateFieldValue(me),
      // Stored values and both bounds are YYYY-MM-DD, so strings compare in date order.
      gte(p.value, from),
      lte(p.value, to),
    ))
    .all()
  // The group's priority, read once apart from the rows, as for the other calendar readers.
  const groupPriorities = await loadGroupPriorities(db, rows.map(r => r.groupKey))

  return rows.filter(r => isCalendarDate(r.value)).map(r => ({
    id: r.groupKey === null ? `cf-${r.fieldId}-${r.billId}` : `cf-${r.fieldId}-group-${r.groupKey}`,
    fieldName: r.fieldName,
    date: r.value,
    title: `${r.fieldName}: ${r.billNumber}`,
    sequence: dateFieldSequence(r.updatedAt),
    bill: {
      id: r.billId, billNumber: r.billNumber, billTitle: billDisplayTitle({ title: r.billTitle, isDraft: r.isDraft }),
      state: r.state, session: r.session, sessionSlug: r.sessionSlug,
      priority: priorityWorn(r, groupPriorities), isDraft: r.isDraft,
    },
  }))
}
