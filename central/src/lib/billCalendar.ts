import { and, eq, isNull, sql } from 'drizzle-orm'
import { billCalendar, billChangeLog } from '../db/schema'
import type { CalendarKind, MeasureCalendarEntry, Provider } from '../providers'
import type { CalendarBlock, Db } from '../types'

/**
 * A bill's calendar entries in central (`bill_calendar`): its hearings,
 * mark-ups, meetings, and deadlines. The same rules hold for every provider.
 *
 * - **Kind.** From the provider's vocabulary, by the entry's event type.
 * - **Identity.** The provider's own event id when it publishes one.
 *   Otherwise the kind, date, and normalized description. Never position.
 *   LegiScan keeps the identity it always had, its type id and description
 *   (`Provider.legacyCalendarIdentity`).
 * - **Cancellation.** Only on positive evidence (the provider marks the entry
 *   cancelled), or once the entry is missing from two successful pulls in a
 *   row. A pull that lists no live entries counts for nothing, and a date
 *   passing never cancels anything.
 * - **No deletes.** A cancelled entry keeps its row, and comes back under the
 *   same identity if the provider lists it again.
 *
 * A pull is an ingest of the bill from its provider, or a later sync pass that
 * lists the bill with the change hash that ingest left: the provider still
 * serves the record the entry was missing from. That pass queues a recheck
 * (`queueCalendarRechecks`), which calls no provider, so LegiScan call counts
 * don't move.
 *
 * Instances build each entry's calendar UID from its identity (hearingUid in
 * api/src/queue/processor.ts), so an entry instances already have never
 * changes identity. A row written before identities were stored (migration
 * 0034) keeps the identity it was sent under.
 */

/** Missing from this many successful pulls in a row, an entry is cancelled. */
export const MISSED_PULLS_TO_CANCEL = 2

/** A `bill_calendar` row. */
export type CalendarRow = typeof billCalendar.$inferSelect

export type CalendarChange = CalendarBlock['changes'][number]

/** An entry's kind, from its event type. An event type the vocabulary doesn't list is a hearing, as every entry was before kinds. */
export function calendarKind(provider: Provider, typeId: number | null): CalendarKind {
  return (typeId ? provider.vocabulary.eventTypes[typeId]?.kind : undefined) ?? 'hearing'
}

function normalizeDescription(description: string | null | undefined): string {
  return (description ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * The identity every entry had before identities were stored, and LegiScan's
 * still: the type id and normalized description, or the date when there is no
 * description. Not the date otherwise, so a LegiScan hearing that moves keeps
 * its identity and instances see it change.
 */
export function legacyCalendarKey(entry: { typeId: number | null; description: string | null; date: string | null }): string {
  const description = normalizeDescription(entry.description)
  return `${entry.typeId || 'x'}|${description || `date:${entry.date ?? ''}`}`
}

type IdentityFields = { typeId: number | null; date: string | null; description: string | null; eventId: string | null }

/** The identity of an entry as the provider lists it. */
function identityOf(provider: Provider, entry: IdentityFields): string {
  if (provider.legacyCalendarIdentity) return legacyCalendarKey(entry)
  if (entry.eventId) return `id:${entry.eventId}`
  return `${calendarKind(provider, entry.typeId)}|${entry.date ?? ''}|${normalizeDescription(entry.description)}`
}

/**
 * The ordinal LIMS used to append to the second and later entries with the
 * same text ("Public Hearing on B26-0400 (2)"). The date now tells them apart.
 */
const LEGACY_ORDINAL = / \((?:[2-9]|[1-9]\d+)\)$/

/** The identity a stored row answers to under the provider's rule. */
function rowIdentity(provider: Provider, row: CalendarRow): string {
  const description = row.identityKey === null && !provider.legacyCalendarIdentity
    ? (row.description ?? '').replace(LEGACY_ORDINAL, '')
    : row.description
  return identityOf(provider, { typeId: row.typeId, date: row.date, description, eventId: row.eventId })
}

/** The identity instances know a stored row by. */
export function sentIdentity(row: CalendarRow): string {
  return row.identityKey ?? legacyCalendarKey(row)
}

/** A bill's entries as instances receive them. */
export function calendarBlockEvents(provider: Provider, rows: CalendarRow[]): CalendarBlock['events'] {
  return [...rows]
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id))
    .map(r => ({
      identityKey: sentIdentity(r),
      kind: calendarKind(provider, r.typeId),
      date: r.date,
      time: r.time,
      location: r.location,
      description: r.description,
      eventHash: r.eventHash,
    }))
}

/** What a pull or a recheck does to a bill's calendar. */
export interface CalendarPlan {
  /** Rows to insert or update. Nothing is deleted. */
  writes: CalendarRow[]
  /** Changes for the change log and instances. */
  changes: CalendarChange[]
  /** Every entry not cancelled, once the plan is written. */
  live: CalendarRow[]
}

function isPast(date: string | null, today: string): boolean {
  return !!date && date < today
}

/** Builds a plan over working copies of a bill's stored rows. */
class Planner {
  private readonly rows: Map<string, CalendarRow>
  private readonly written = new Set<string>()
  readonly changes: CalendarChange[] = []

  constructor(private readonly provider: Provider, prior: CalendarRow[], private readonly now: string) {
    this.rows = new Map(prior.map(r => [r.id, { ...r }]))
  }

  get all(): CalendarRow[] {
    return [...this.rows.values()]
  }

  private get today(): string {
    return this.now.slice(0, 10)
  }

  touch(row: CalendarRow): void {
    this.rows.set(row.id, row)
    this.written.add(row.id)
  }

  wrote(row: CalendarRow): boolean {
    return this.written.has(row.id)
  }

  change(changeType: CalendarChange['changeType'], row: CalendarRow): void {
    this.changes.push({
      changeType,
      identityKey: sentIdentity(row),
      kind: calendarKind(this.provider, row.typeId),
      date: row.date, time: row.time, location: row.location, description: row.description, eventHash: row.eventHash,
    })
  }

  /** Cancel a live row. A past entry is cancelled quietly: nobody needs telling. */
  cancel(row: CalendarRow): void {
    row.cancelledAt = this.now
    this.touch(row)
    if (!isPast(row.date, this.today)) this.change('hearing_cancelled', row)
  }

  /** One more successful pull the row was missing from. */
  miss(row: CalendarRow, pullHash: string): void {
    row.missedPulls += 1
    row.missedHash = pullHash
    this.touch(row)
    if (row.missedPulls >= MISSED_PULLS_TO_CANCEL) this.cancel(row)
  }

  plan(): CalendarPlan {
    return {
      writes: [...this.written].map(id => this.rows.get(id)!),
      changes: this.changes,
      live: this.all.filter(r => !r.cancelledAt),
    }
  }
}

/**
 * What one pull of a bill does to its calendar: `incoming` is every entry the
 * provider lists for the bill, and `pullHash` the bill's change hash in that
 * pull. `now` is central's clock (nowDb()).
 */
export function planCalendarPull(
  provider: Provider,
  billId: number,
  prior: CalendarRow[],
  incoming: MeasureCalendarEntry[],
  pullHash: string,
  now: string,
): CalendarPlan {
  const planner = new Planner(provider, prior, now)
  if (incoming.length === 0) return planner.plan()

  // Stored rows by the identity they answer to. Of two with one identity, a live one is kept.
  const stored = new Map<string, CalendarRow>()
  for (const row of planner.all) {
    const key = rowIdentity(provider, row)
    const held = stored.get(key)
    if (!held || (held.cancelledAt && !row.cancelledAt)) stored.set(key, row)
  }

  // One entry per identity: the last listed, except that a cancelled one always wins.
  const listed = new Map<string, MeasureCalendarEntry>()
  for (const e of incoming) {
    const key = identityOf(provider, {
      typeId: e.type_id || null, date: e.date || null, description: e.description || null, eventId: e.event_id || null,
    })
    if (!listed.get(key)?.cancelled) listed.set(key, e)
  }

  const accounted = new Set<string>()
  for (const [key, e] of listed) {
    const row = stored.get(key)
    if (e.cancelled) {
      // Positive evidence cancels at once. An entry never listed live has nothing to cancel.
      if (!row) continue
      accounted.add(row.id)
      if (!row.cancelledAt) planner.cancel(row)
      continue
    }

    const fields = {
      typeId: e.type_id || null, type: e.type || null, date: e.date || null, time: e.time || null,
      location: e.location || null, description: e.description || null, eventHash: e.event_hash || null,
      eventId: e.event_id || null,
    }
    if (!row) {
      const added: CalendarRow = { id: crypto.randomUUID(), billId, ...fields, identityKey: key, missedPulls: 0, missedHash: null, cancelledAt: null }
      planner.touch(added)
      planner.change('hearing_added', added)
      continue
    }

    accounted.add(row.id)
    const before = { ...row }
    // A row stored before identities were keeps the identity instances know it by.
    Object.assign(row, fields, { identityKey: sentIdentity(before), missedPulls: 0, missedHash: null, cancelledAt: null })
    if ((Object.keys(row) as (keyof CalendarRow)[]).some(k => row[k] !== before[k])) planner.touch(row)

    if (before.cancelledAt) {
      planner.change('hearing_added', row)
    } else if ((before.eventHash ?? '') !== (row.eventHash ?? '')) {
      const suppressedAsPast = isPast(row.date, now.slice(0, 10))
      const diff: Record<string, [unknown, unknown]> = {}
      for (const k of ['date', 'time', 'location', 'description'] as const) {
        if ((before[k] ?? '') !== (row[k] ?? '')) diff[k] = [before[k], row[k]]
      }
      console.log('[calendar-change] hearing_changed', JSON.stringify({
        identityKey: row.identityKey, oldHash: before.eventHash, newHash: row.eventHash, date: row.date, diff, suppressedAsPast,
      }))
      if (!suppressedAsPast) planner.change('hearing_changed', row)
    }
  }

  // A pull that lists no live entry (none at all, or only cancellations) is
  // no evidence that any other went away.
  if (![...listed.values()].some(e => !e.cancelled)) return planner.plan()

  for (const row of planner.all) {
    if (accounted.has(row.id) || row.cancelledAt || planner.wrote(row)) continue
    if (stored.get(rowIdentity(provider, row)) !== row) {
      // A second row under an identity another row holds: the same entry, stored twice before identities were. Retired quietly.
      row.cancelledAt = now
      planner.touch(row)
      continue
    }
    planner.miss(row, pullHash)
  }
  return planner.plan()
}

/**
 * A recheck: a sync pass found the bill's change hash still `pullHash`, the
 * hash of the pull its missing entries were last missing from. The provider
 * still serves that record, so each of them is missing from one more pull.
 */
export function planCalendarRecheck(provider: Provider, prior: CalendarRow[], pullHash: string, now: string): CalendarPlan {
  const planner = new Planner(provider, prior, now)
  for (const row of planner.all) {
    if (!row.cancelledAt && row.missedPulls > 0 && row.missedHash === pullHash) planner.miss(row, pullHash)
  }
  return planner.plan()
}

export async function readCalendarRows(db: Db, billId: number): Promise<CalendarRow[]> {
  return db.select().from(billCalendar).where(eq(billCalendar.billId, billId)).all()
}

export async function writeCalendarRows(db: Db, rows: CalendarRow[]): Promise<void> {
  const stmts = rows.map(row => {
    const { id: _id, ...set } = row
    return db.insert(billCalendar).values(row).onConflictDoUpdate({ target: billCalendar.id, set })
  })
  for (let i = 0; i < stmts.length; i += 50) {
    const chunk = stmts.slice(i, i + 50)
    await db.batch(chunk as [typeof chunk[0], ...typeof chunk])
  }
}

/** Record calendar changes in the bill's change log. */
export async function logCalendarChanges(db: Db, billId: number, changes: CalendarChange[], now: string): Promise<void> {
  for (const change of changes) {
    await db.insert(billChangeLog).values({
      id: crypto.randomUUID(),
      billId,
      changeType: change.changeType,
      oldValue: null,
      newValue: change.description ?? null,
      detail: change.date ?? null,
      detectedAt: now,
    })
  }
}

/**
 * Queue a recheck (`planCalendarRecheck`) for each bill a sync pass listed
 * unchanged whose calendar has an entry missing from the pull with that very
 * hash. `unchanged` maps each unchanged bill to the change hash it was listed
 * with. Reads only the rows of missing entries (a partial index).
 */
export async function queueCalendarRechecks(db: Db, queue: Queue, unchanged: Map<number, string>): Promise<number> {
  if (unchanged.size === 0) return 0
  const missing = await db.selectDistinct({ billId: billCalendar.billId, missedHash: billCalendar.missedHash })
    .from(billCalendar)
    // A literal 0, so the query matches the partial index's WHERE.
    .where(and(sql`${billCalendar.missedPulls} > 0`, isNull(billCalendar.cancelledAt)))
    .all()
  const due = new Map<number, string>()
  for (const m of missing) {
    const hash = unchanged.get(m.billId)
    if (hash !== undefined && hash === m.missedHash) due.set(m.billId, hash)
  }
  const bodies = [...due].map(([billId, calendarRecheck]) => ({ body: { billId, calendarRecheck } }))
  for (let i = 0; i < bodies.length; i += 100) await queue.sendBatch(bodies.slice(i, i + 100))
  return due.size
}
