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

/**
 * The entry instances get for each identity. LegiScan entries with the same
 * type and description on different days share one identity, and so one
 * calendar UID, as they always have. Of the live rows that share one, the
 * latest wins. A row missing from a pull still counts until it is cancelled,
 * so one bad pull changes nothing instances see.
 */
function representatives(rows: Iterable<CalendarRow>): Map<string, CalendarRow> {
  const out = new Map<string, CalendarRow>()
  for (const row of rows) {
    if (row.cancelledAt) continue
    const key = sentIdentity(row)
    const held = out.get(key)
    if (!held || outranks(row, held)) out.set(key, row)
  }
  return out
}

function outranks(a: CalendarRow, b: CalendarRow): boolean {
  return ((a.date ?? '').localeCompare(b.date ?? '') || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id)) > 0
}

/** A bill's entries as instances receive them: one per identity. */
export function calendarBlockEvents(provider: Provider, rows: CalendarRow[]): CalendarBlock['events'] {
  return [...representatives(rows).values()]
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
  /** What instances see change, for the change log and instances. */
  changes: CalendarChange[]
  /** Every entry not cancelled, once the plan is written. */
  live: CalendarRow[]
}

function isPast(date: string | null, today: string): boolean {
  return !!date && date < today
}

/**
 * The changes instances see, identity by identity: an identity that appears
 * is added, one that disappears is cancelled, and one whose entry's hash moves
 * is changed. A past entry that changes or is cancelled is not reported.
 */
function calendarChanges(provider: Provider, before: CalendarRow[], after: CalendarRow[], today: string): CalendarChange[] {
  const was = representatives(before)
  const now = representatives(after)
  const change = (changeType: CalendarChange['changeType'], row: CalendarRow): CalendarChange => ({
    changeType,
    identityKey: sentIdentity(row),
    kind: calendarKind(provider, row.typeId),
    date: row.date, time: row.time, location: row.location, description: row.description, eventHash: row.eventHash,
  })
  const changes: CalendarChange[] = []
  for (const [key, row] of now) {
    const prev = was.get(key)
    if (!prev) {
      changes.push(change('hearing_added', row))
    } else if ((prev.eventHash ?? '') !== (row.eventHash ?? '')) {
      const suppressedAsPast = isPast(row.date, today)
      const diff: Record<string, [unknown, unknown]> = {}
      for (const k of ['date', 'time', 'location', 'description'] as const) {
        if ((prev[k] ?? '') !== (row[k] ?? '')) diff[k] = [prev[k], row[k]]
      }
      console.log('[calendar-change] hearing_changed', JSON.stringify({
        identityKey: key, oldHash: prev.eventHash, newHash: row.eventHash, date: row.date, diff, suppressedAsPast,
      }))
      if (!suppressedAsPast) changes.push(change('hearing_changed', row))
    }
  }
  for (const [key, prev] of was) {
    if (!now.has(key) && !isPast(prev.date, today)) changes.push(change('hearing_cancelled', prev))
  }
  return changes
}

/** Working copies of a bill's rows, and which of them a plan writes. */
class Rows {
  private readonly rows: Map<string, CalendarRow>
  private readonly written = new Set<string>()

  constructor(private readonly prior: CalendarRow[]) {
    this.rows = new Map(prior.map(r => [r.id, { ...r }]))
  }

  get all(): CalendarRow[] {
    return [...this.rows.values()]
  }

  touch(row: CalendarRow): void {
    this.rows.set(row.id, row)
    this.written.add(row.id)
  }

  wrote(row: CalendarRow): boolean {
    return this.written.has(row.id)
  }

  /** One more successful pull the row was missing from. */
  miss(row: CalendarRow, pullHash: string, now: string): void {
    row.missedPulls += 1
    row.missedHash = pullHash
    if (row.missedPulls >= MISSED_PULLS_TO_CANCEL) row.cancelledAt = now
    this.touch(row)
  }

  plan(provider: Provider, now: string): CalendarPlan {
    const all = this.all
    return {
      writes: [...this.written].map(id => this.rows.get(id)!),
      changes: calendarChanges(provider, this.prior, all, now.slice(0, 10)),
      live: all.filter(r => !r.cancelledAt),
    }
  }
}

/**
 * Pair a provider's entries with the stored rows of one identity. Most
 * identities hold one entry. LegiScan's can hold several, on different days:
 * each keeps the row for its day, and the rest pair up in date order, so a
 * LegiScan hearing that moves keeps its row.
 */
function pairWithRows(entries: MeasureCalendarEntry[], rows: CalendarRow[]): [MeasureCalendarEntry, CalendarRow | undefined][] {
  const free = [...rows].sort((a, b) =>
    Number(!!a.cancelledAt) - Number(!!b.cancelledAt) || (a.date ?? '').localeCompare(b.date ?? ''))
  const pairs: [MeasureCalendarEntry, CalendarRow | undefined][] = []
  const unpaired: MeasureCalendarEntry[] = []
  for (const e of entries) {
    const i = free.findIndex(r => (r.date ?? '') === (e.date || ''))
    if (i >= 0) pairs.push([e, free.splice(i, 1)[0]])
    else unpaired.push(e)
  }
  for (const e of unpaired.sort((a, b) => (a.date || '').localeCompare(b.date || ''))) pairs.push([e, free.shift()])
  return pairs
}

function groupBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    out.set(k, [...(out.get(k) ?? []), item])
  }
  return out
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
  const rows = new Rows(prior)
  if (incoming.length === 0) return rows.plan(provider, now)

  // Each entry once: listed twice, the last listing counts, unless one says cancelled.
  const listed = new Map<string, { identity: string; entry: MeasureCalendarEntry }>()
  for (const entry of incoming) {
    const identity = identityOf(provider, {
      typeId: entry.type_id || null, date: entry.date || null, description: entry.description || null, eventId: entry.event_id || null,
    })
    // LegiScan's identity leaves out the date, so its entries are told apart by it too.
    const key = provider.legacyCalendarIdentity ? `${identity}|${entry.date || ''}` : identity
    if (!listed.get(key)?.entry.cancelled) listed.set(key, { identity, entry })
  }

  const stored = groupBy(rows.all, row => rowIdentity(provider, row))
  const accounted = new Set<string>()
  for (const [identity, group] of groupBy(listed.values(), l => l.identity)) {
    for (const [e, row] of pairWithRows(group.map(l => l.entry), stored.get(identity) ?? [])) {
      if (e.cancelled) {
        // Positive evidence cancels at once. An entry never stored has nothing to cancel.
        if (!row) continue
        accounted.add(row.id)
        if (!row.cancelledAt) {
          row.cancelledAt = now
          rows.touch(row)
        }
        continue
      }
      const fields = {
        typeId: e.type_id || null, type: e.type || null, date: e.date || null, time: e.time || null,
        location: e.location || null, description: e.description || null, eventHash: e.event_hash || null,
        eventId: e.event_id || null,
      }
      if (!row) {
        rows.touch({ id: crypto.randomUUID(), billId, ...fields, identityKey: identity, missedPulls: 0, missedHash: null, cancelledAt: null })
        continue
      }
      accounted.add(row.id)
      const before = { ...row }
      // A row stored before identities were keeps the identity instances know it by.
      Object.assign(row, fields, { identityKey: sentIdentity(before), missedPulls: 0, missedHash: null, cancelledAt: null })
      if ((Object.keys(row) as (keyof CalendarRow)[]).some(k => row[k] !== before[k])) rows.touch(row)
    }
  }

  // A pull that lists no live entry (none at all, or only cancellations) is
  // no evidence that any other went away.
  if (![...listed.values()].some(l => !l.entry.cancelled)) return rows.plan(provider, now)

  for (const row of rows.all) {
    if (accounted.has(row.id) || row.cancelledAt || rows.wrote(row)) continue
    // Already counted missing from a pull of this very record (an ingest
    // retried, or run twice): a recheck counts the next one.
    if (row.missedHash === pullHash) continue
    rows.miss(row, pullHash, now)
  }
  return rows.plan(provider, now)
}

/** What a cutover's carry-over does to a bill's calendar (`carryCalendar`). */
export interface CalendarCarry {
  /** Every row, as the carry leaves it, for the pull that follows. */
  rows: CalendarRow[]
  /** The rows it changed. */
  writes: CalendarRow[]
  /** Each live row that keeps its identity, as it was and as it is now, and the entry it carries. */
  kept: { identityKey: string; before: CalendarRow; row: CalendarRow; entry: MeasureCalendarEntry }[]
  /** Live rows nothing pairs with, cancelled. */
  cancelled: CalendarRow[]
  /** Live entries nothing pairs with, which arrive under identities of their own. */
  added: MeasureCalendarEntry[]
}

/**
 * A cutover's carry-over (lib/cutover.ts), run on the first ingest of a bill
 * the cutover moved from provider `from` to provider `to`. Each live row
 * `from` wrote is paired with a live entry `to` lists on the same date and of
 * the same kind (each side's kind from its own vocabulary), in time order, and
 * takes that entry's fields while keeping the identity instances know it by.
 * The pull that follows then pairs the two, so the entry stays one event in
 * every subscriber's calendar. A live row nothing pairs with is cancelled at
 * once, since `from` no longer serves the bill and will never list it again.
 * Entries nothing pairs with are new, and get identities of their own.
 */
export function carryCalendar(
  from: Provider, to: Provider, prior: CalendarRow[], incoming: MeasureCalendarEntry[], now: string,
): CalendarCarry {
  const rows = prior.map(r => ({ ...r }))
  const writes: CalendarRow[] = []
  const kept: CalendarCarry['kept'] = []
  const order = (a: { time: string | null; description: string | null }, b: { time: string | null; description: string | null }) =>
    (a.time ?? '').localeCompare(b.time ?? '') || normalizeDescription(a.description).localeCompare(normalizeDescription(b.description))

  const live = rows.filter(r => !r.cancelledAt)
  const rowsBySlot = groupBy(live, r => `${r.date ?? ''}|${calendarKind(from, r.typeId)}`)
  const entries = incoming.filter(e => !e.cancelled)
  const entriesBySlot = groupBy(entries, e => `${e.date || ''}|${calendarKind(to, e.type_id || null)}`)
  const paired = new Set<string>()
  const added: MeasureCalendarEntry[] = []

  for (const [slot, group] of entriesBySlot) {
    const free = [...(rowsBySlot.get(slot) ?? [])].sort((a, b) => order(a, b) || a.id.localeCompare(b.id))
    const sorted = [...group].sort((a, b) => order({ time: a.time || null, description: a.description || null }, { time: b.time || null, description: b.description || null }))
    for (const entry of sorted) {
      const row = free.shift()
      if (!row) { added.push(entry); continue }
      const identityKey = sentIdentity(row)
      const before = { ...row }
      Object.assign(row, {
        typeId: entry.type_id || null, type: entry.type || null, date: entry.date || null, time: entry.time || null,
        location: entry.location || null, description: entry.description || null, eventHash: entry.event_hash || null,
        eventId: entry.event_id || null, identityKey, missedPulls: 0, missedHash: null,
      })
      paired.add(row.id)
      writes.push(row)
      kept.push({ identityKey, before, row, entry })
    }
  }

  const cancelled: CalendarRow[] = []
  for (const row of live) {
    if (paired.has(row.id)) continue
    // Keep the identity it was sent under, so an instance cancels the event it has.
    Object.assign(row, { identityKey: sentIdentity(row), cancelledAt: now })
    writes.push(row)
    cancelled.push(row)
  }
  return { rows, writes, kept, cancelled, added }
}

/**
 * A recheck: a sync pass found the bill's change hash still `pullHash`, the
 * hash of the pull its missing entries were last missing from. The provider
 * still serves that record, so each of them is missing from one more pull.
 */
export function planCalendarRecheck(provider: Provider, prior: CalendarRow[], pullHash: string, now: string): CalendarPlan {
  const rows = new Rows(prior)
  for (const row of rows.all) {
    if (!row.cancelledAt && row.missedPulls > 0 && row.missedHash === pullHash) rows.miss(row, pullHash, now)
  }
  return rows.plan(provider, now)
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
