import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm'
import { bills, billCalendar, bodyEventBills, bodyEvents, committees, sessions } from '../db/schema'
import { isCalendarKind } from '../../../shared/calendarKinds'
import { calendarKind, MISSED_PULLS_TO_CANCEL, sentIdentity, type CalendarRow } from './billCalendar'
import { upsertCommitteeRows } from './committees'
import { toHandle } from './billHandle'
import type { BodyEvent, CalendarKind, Provider } from '../providers'
import type { Db } from '../types'

/**
 * Body events (#297): a legislature's own calendar of hearings, roundtables,
 * and meetings, with or without bills on the agenda, from a provider's
 * `listBodyEvents` (DC's Council calendar, from LIMS). The rules are the ones
 * bill calendar entries follow (lib/billCalendar.ts):
 *
 * - **Kind.** Every event has one, set by the provider from its own type.
 * - **Identity.** The provider's own event id, always. A moved or retitled
 *   event is the same event, changed.
 * - **Cancellation.** Only on positive evidence (the provider marks the event
 *   cancelled), or once the event is missing from two successful pulls in a
 *   row. A pull is one month of the provider's calendar, and only a month that
 *   lists a live event counts: a failed month changes nothing, and an empty one
 *   is no evidence that anything went away. A date passing never cancels
 *   anything.
 * - **No deletes.** A cancelled event keeps its row, and comes back if the
 *   provider lists it again.
 *
 * Central links each agenda item to the bill it names, and a numberless one
 * to the bill whose calendar entry that day carries its words (DC's hearing
 * notices). A bill's calendar entry on the day of an event with the bill on
 * its agenda is covered by the event: the bill API and every calendar block
 * name the event's UID (`coveredBy`), and instances show the event in its
 * place, so the hearing appears once.
 *
 * Instances pull the events for the states they cover through
 * GET /tenants/:tenantId/body-events, and build nothing themselves: each event
 * goes out with its calendar UID (bodyEventUid).
 */

/** A `body_events` row. */
export type BodyEventRow = typeof bodyEvents.$inferSelect

type BodyEventValues = Omit<typeof bodyEvents.$inferInsert, 'id' | 'createdAt'>

/** One month of a provider's calendar, as it listed it: every event dated from `from` to `to`. */
export interface BodyEventPull {
  from: string
  to: string
  events: BodyEvent[]
}

/** How far around today core reads a provider's calendar: last month through three months ahead. */
export const BODY_EVENT_MONTHS = { back: 1, ahead: 3 } as const

/** The months core reads, as date ranges, around `today` (YYYY-MM-DD). */
export function bodyEventMonths(today: string): { from: string; to: string }[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7)) - 1
  const out: { from: string; to: string }[] = []
  for (let offset = -BODY_EVENT_MONTHS.back; offset <= BODY_EVENT_MONTHS.ahead; offset++) {
    const first = new Date(Date.UTC(year, month + offset, 1))
    const last = new Date(Date.UTC(year, month + offset + 1, 0))
    out.push({ from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) })
  }
  return out
}

/**
 * The calendar UID instances give a provider's body event:
 * `body-<provider>-<event id>@floorvote.org`, or the provider's own scheme
 * (`Provider.bodyEventUid`, which LIMS keeps for the UIDs a fork already
 * issued). It never changes for an event.
 */
export function bodyEventUid(provider: Provider, eventId: string): string {
  return provider.bodyEventUid?.(eventId) ?? `body-${provider.id}-${encodeURIComponent(eventId)}@floorvote.org`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

/**
 * Throw on an event core can't store, so the month it came in changes
 * nothing. Dropping it instead would read as the event going missing.
 */
function checkBodyEvent(provider: Provider, e: BodyEvent): void {
  const bad = (what: string) => new Error(`[body-events] ${provider.id} event ${JSON.stringify(e?.event_id ?? null)}: ${what}`)
  if (typeof e?.event_id !== 'string' || !e.event_id) throw bad('no event id')
  if (!isCalendarKind(e.kind)) throw bad(`kind ${JSON.stringify(e.kind)} isn't one of the calendar kinds`)
  if (typeof e.date !== 'string' || !DATE_RE.test(e.date) || Number.isNaN(Date.parse(e.date))) throw bad('no date')
  if (e.time !== null && (typeof e.time !== 'string' || !TIME_RE.test(e.time))) throw bad('a time that isn\'t HH:MM')
  if (typeof e.title !== 'string' || !e.title.trim()) throw bad('no title')
  if (typeof e.event_hash !== 'string' || !e.event_hash) throw bad('no event hash')
  if (e.url !== null && !/^https?:\/\//i.test(e.url ?? '')) throw bad('a url that isn\'t http(s)')
  if (!Array.isArray(e.agenda) || e.agenda.some(a => typeof a?.topic !== 'string')) throw bad('no agenda list')
}

/** What a listed event writes to its row. */
function eventValues(provider: Provider, state: string, e: BodyEvent): Omit<BodyEventValues, 'missedPulls' | 'cancelledAt' | 'updatedAt'> {
  return {
    provider: provider.id,
    eventId: e.event_id,
    state,
    kind: e.kind,
    type: e.type || null,
    date: e.date,
    time: e.time,
    timezone: e.timezone || null,
    committeeId: e.committee?.committee_id || null,
    committee: e.committee?.name || null,
    jointWith: e.joint_with || null,
    location: e.location || null,
    title: e.title.trim(),
    agendaJson: JSON.stringify(e.agenda.map(a => ({ topic: a.topic, billNumber: a.bill_number || null }))),
    url: e.url || null,
    eventHash: e.event_hash,
  }
}

function storedValues(row: BodyEventRow): BodyEventValues {
  const { id: _id, createdAt: _created, ...values } = row
  return values
}

/**
 * What one sync's pulls do to a provider's events in a state. `prior` holds
 * the stored rows dated within the pulls' months and the rows of every event
 * they list. Returns the rows to write, each whole. Nothing is deleted.
 */
export function planBodyEventPulls(
  provider: Provider, state: string, prior: BodyEventRow[], pulls: BodyEventPull[], now: string,
): BodyEventValues[] {
  const stored = new Map(prior.map(r => [r.eventId, r]))
  // Each event once: listed twice, the last listing counts, unless one says cancelled.
  const listed = new Map<string, BodyEvent>()
  for (const pull of pulls) {
    for (const e of pull.events) if (!listed.get(e.event_id)?.cancelled) listed.set(e.event_id, e)
  }

  const writes: BodyEventValues[] = []
  for (const e of listed.values()) {
    const row = stored.get(e.event_id)
    if (e.cancelled) {
      // Positive evidence cancels at once. An event never stored has nothing to cancel.
      if (row && !row.cancelledAt) writes.push({ ...storedValues(row), cancelledAt: now, updatedAt: now })
      continue
    }
    const values = eventValues(provider, state, e)
    const unchanged = row && !row.cancelledAt && row.missedPulls === 0
      && (Object.keys(values) as (keyof typeof values)[]).every(k => row[k] === values[k])
    if (!unchanged) writes.push({ ...values, missedPulls: 0, cancelledAt: null, updatedAt: now })
  }

  // A month that lists no live event (none at all, or only cancellations) is
  // no evidence that any other went away.
  const counting = pulls.filter(p => p.events.some(e => !e.cancelled))
  for (const row of prior) {
    if (row.cancelledAt || listed.has(row.eventId)) continue
    if (!counting.some(p => p.from <= row.date && row.date <= p.to)) continue
    const missedPulls = row.missedPulls + 1
    writes.push({
      ...storedValues(row), missedPulls, updatedAt: now,
      cancelledAt: missedPulls >= MISSED_PULLS_TO_CANCEL ? now : null,
    })
  }
  return writes
}

const CHUNK = 80

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function batch(db: Db, stmts: any[]): Promise<void> {
  for (const chunk of chunks(stmts, 50)) if (chunk.length > 0) await db.batch(chunk as [any, ...any[]])
}

export interface BodyEventSyncReport {
  state: string
  /** Months the provider answered, and months it failed. */
  months: number
  failed: number
  events: number
  written: number
}

/**
 * One sync of a provider's calendar for a state: each month in
 * BODY_EVENT_MONTHS, then the events, their committees, and their agenda
 * links. A month the provider fails on is logged and left as it was.
 */
export async function syncBodyEvents(
  provider: Provider,
  state: string,
  list: (range: { from: string; to: string }) => Promise<BodyEvent[]>,
  db: Db,
  today: string,
  now: string,
): Promise<BodyEventSyncReport> {
  const pulls: BodyEventPull[] = []
  let failed = 0
  for (const range of bodyEventMonths(today)) {
    try {
      const events = await list(range)
      for (const e of events) checkBodyEvent(provider, e)
      pulls.push({ ...range, events })
    } catch (err) {
      failed++
      console.error(`[body-events] ${provider.id} ${state} ${range.from.slice(0, 7)} failed, left as it was:`, err)
    }
  }
  const report = { state, months: pulls.length, failed, events: pulls.reduce((n, p) => n + p.events.length, 0), written: 0 }
  if (pulls.length === 0) return report

  const prior = await priorRows(db, provider.id, state, pulls)
  const writes = planBodyEventPulls(provider, state, prior, pulls, now)
  await batch(db, writes.map(values => {
    const { provider: _p, eventId: _e, ...set } = values
    return db.insert(bodyEvents).values(values).onConflictDoUpdate({ target: [bodyEvents.provider, bodyEvents.eventId], set })
  }))
  report.written = writes.length

  const live = new Map<string, BodyEvent>()
  for (const pull of pulls) for (const e of pull.events) if (!e.cancelled) live.set(e.event_id, e)
  await upsertEventCommittees(db, provider, state, [...live.values()])
  await linkAgendas(db, provider, state, [...live.values()])
  return report
}

async function priorRows(db: Db, providerId: string, state: string, pulls: BodyEventPull[]): Promise<BodyEventRow[]> {
  const from = pulls.reduce((m, p) => (p.from < m ? p.from : m), pulls[0].from)
  const to = pulls.reduce((m, p) => (p.to > m ? p.to : m), pulls[0].to)
  const ids = [...new Set(pulls.flatMap(p => p.events.map(e => e.event_id)))]
  const rows = new Map<number, BodyEventRow>()
  const scope = and(eq(bodyEvents.provider, providerId), eq(bodyEvents.state, state))
  for (const r of await db.select().from(bodyEvents)
    .where(and(scope, gte(bodyEvents.date, from), lte(bodyEvents.date, to))).all()) rows.set(r.id, r)
  // An event listed in these months may be stored under a date outside them (it moved).
  for (const chunk of chunks(ids)) {
    for (const r of await db.select().from(bodyEvents)
      .where(and(eq(bodyEvents.provider, providerId), inArray(bodyEvents.eventId, chunk))).all()) rows.set(r.id, r)
  }
  return [...rows.values()]
}

/**
 * A committees row for each committee holding an event, from the provider's
 * session for the state that spans the event's year, so the committee list
 * includes one that holds only oversight hearings. An event whose year no
 * session spans names its committee without a row, until a later sync.
 */
async function upsertEventCommittees(db: Db, provider: Provider, state: string, events: BodyEvent[]): Promise<void> {
  const held = events.filter(e => e.committee?.committee_id && e.committee.name.trim())
  if (held.length === 0) return
  const stateSessions = await db.select({ sessionId: sessions.sessionId, yearStart: sessions.yearStart, yearEnd: sessions.yearEnd, prior: sessions.prior })
    .from(sessions).where(and(eq(sessions.state, state), eq(sessions.provider, provider.id)))
    .orderBy(asc(sessions.prior), asc(sessions.sessionId)).all()
  const rows = new Map<number, Parameters<typeof upsertCommitteeRows>[1][number]>()
  // Events in date order, so a committee takes its name from its latest event.
  for (const e of [...held].sort((a, b) => a.date.localeCompare(b.date))) {
    const year = Number(e.date.slice(0, 4))
    const session = stateSessions.find(s => s.yearStart <= year && year <= s.yearEnd)
    if (!session) continue
    const c = e.committee!
    rows.set(c.committee_id, {
      committeeId: c.committee_id, state, sessionId: session.sessionId,
      chamber: c.chamber, chamberId: 0, name: c.name.trim(), provider: provider.id,
    })
  }
  await upsertCommitteeRows(db, [...rows.values()], provider)
}

/** Lower case, apostrophes dropped, every other run of non-letters a space. */
function topicKey(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** A numberless topic shorter than this matches no bill: too many titles contain it. */
const MIN_TOPIC_KEY = 12

/**
 * Whether a numberless topic names the bill whose title or entry is `text`:
 * the text carries the topic's words, and they are most of it. So a notice
 * titled with the roundtable's own words pairs, and a long bill title that
 * happens to mention an agency an oversight hearing is about doesn't.
 */
function topicNames(topic: string, text: string): boolean {
  return text.includes(topic) && topic.length * 2 >= text.length
}

/**
 * Point each listed event's links at the bills on its agenda, writing only
 * where they changed. An item with a bill number links the provider's bill of
 * that number in the state (the one whose session spans the event's year,
 * when numbers repeat across sessions). An item without one links the one
 * bill with a live calendar entry that day whose title or entry is mostly the
 * item's words (topicNames), which is how DC's oversight hearing notices pair
 * with the Council's calendar.
 */
async function linkAgendas(db: Db, provider: Provider, state: string, events: BodyEvent[]): Promise<void> {
  if (events.length === 0) return
  const numbers = [...new Set(events.flatMap(e => e.agenda.map(a => a.bill_number?.trim()).filter((n): n is string => !!n)))]
  const byNumber = new Map<string, { billId: number; yearStart: number | null; yearEnd: number | null }[]>()
  for (const chunk of chunks(numbers)) {
    const rows = await db.select({ billId: bills.billId, number: bills.billNumber, yearStart: sessions.yearStart, yearEnd: sessions.yearEnd })
      .from(bills).leftJoin(sessions, eq(sessions.sessionId, bills.sessionId))
      .where(and(eq(bills.state, state), eq(bills.provider, provider.id), inArray(bills.billNumber, chunk))).all()
    for (const r of rows) byNumber.set(r.number, [...(byNumber.get(r.number) ?? []), r])
  }

  const dates = [...new Set(events.filter(e => e.agenda.some(a => !a.bill_number)).map(e => e.date))]
  const entriesByDate = new Map<string, { billId: number; keys: string[] }[]>()
  for (const chunk of chunks(dates)) {
    const rows = await db.select({ billId: billCalendar.billId, date: billCalendar.date, typeId: billCalendar.typeId, description: billCalendar.description, title: bills.title })
      .from(billCalendar).innerJoin(bills, eq(bills.billId, billCalendar.billId))
      .where(and(inArray(billCalendar.date, chunk), isNull(billCalendar.cancelledAt), eq(bills.state, state), eq(bills.provider, provider.id))).all()
    for (const r of rows) {
      if (!r.date || calendarKind(provider, r.typeId) === 'deadline') continue
      entriesByDate.set(r.date, [...(entriesByDate.get(r.date) ?? []), { billId: r.billId, keys: [topicKey(r.title), topicKey(r.description)] }])
    }
  }

  const want = new Map<string, number[]>()
  for (const e of events) {
    const year = Number(e.date.slice(0, 4))
    const ids = new Set<number>()
    for (const item of e.agenda) {
      const number = item.bill_number?.trim()
      if (number) {
        const found = byNumber.get(number) ?? []
        const pick = found.find(b => (b.yearStart ?? 0) <= year && year <= (b.yearEnd ?? 0)) ?? [...found].sort((a, b) => b.billId - a.billId)[0]
        if (pick) ids.add(pick.billId)
        continue
      }
      const key = topicKey(item.topic)
      if (key.length < MIN_TOPIC_KEY) continue
      const hits = new Set((entriesByDate.get(e.date) ?? []).filter(x => x.keys.some(k => topicNames(key, k))).map(x => x.billId))
      if (hits.size === 1) ids.add([...hits][0])
    }
    want.set(e.event_id, [...ids].sort((a, b) => a - b))
  }

  const rowIds = new Map<string, number>()
  for (const chunk of chunks([...want.keys()])) {
    for (const r of await db.select({ id: bodyEvents.id, eventId: bodyEvents.eventId }).from(bodyEvents)
      .where(and(eq(bodyEvents.provider, provider.id), inArray(bodyEvents.eventId, chunk))).all()) rowIds.set(r.eventId, r.id)
  }
  const current = new Map<number, number[]>()
  for (const chunk of chunks([...rowIds.values()])) {
    for (const r of await db.select().from(bodyEventBills).where(inArray(bodyEventBills.bodyEventId, chunk)).all()) {
      current.set(r.bodyEventId, [...(current.get(r.bodyEventId) ?? []), r.billId])
    }
  }
  const stmts: any[] = []
  for (const [eventId, billIds] of want) {
    const id = rowIds.get(eventId)
    if (id === undefined) continue
    const have = (current.get(id) ?? []).sort((a, b) => a - b)
    if (have.length === billIds.length && have.every((b, i) => b === billIds[i])) continue
    stmts.push(db.delete(bodyEventBills).where(eq(bodyEventBills.bodyEventId, id)))
    for (const billId of billIds) stmts.push(db.insert(bodyEventBills).values({ bodyEventId: id, billId }).onConflictDoNothing())
  }
  await batch(db, stmts)
}

/** An event that may cover a bill's calendar entry. */
interface Cover {
  id: number
  eventId: string
  date: string
  time: string | null
  kind: string
}

/**
 * Of the events with a bill on their agenda, the one covering a calendar
 * entry of the bill: an event that day, preferring one of the entry's kind,
 * then the earliest, so the choice is the same wherever it is made. None for
 * a deadline, which isn't a meeting.
 */
function chooseCover(kind: CalendarKind, date: string | null, covers: Cover[]): Cover | undefined {
  if (kind === 'deadline' || !date) return undefined
  return covers
    .filter(c => c.date === date)
    .sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind)
      || (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.id - b.id)[0]
}

/** The provider's events (cancelled ones too) linking each of these bills, by bill. */
async function coversByBill(db: Db, provider: Provider, billIds: number[]): Promise<Map<number, Cover[]>> {
  const out = new Map<number, Cover[]>()
  for (const chunk of chunks(billIds)) {
    const rows = await db.select({
      billId: bodyEventBills.billId, id: bodyEvents.id, eventId: bodyEvents.eventId,
      date: bodyEvents.date, time: bodyEvents.time, kind: bodyEvents.kind,
    })
      .from(bodyEventBills).innerJoin(bodyEvents, eq(bodyEvents.id, bodyEventBills.bodyEventId))
      .where(and(inArray(bodyEventBills.billId, chunk), eq(bodyEvents.provider, provider.id))).all()
    for (const { billId, ...c } of rows) out.set(billId, [...(out.get(billId) ?? []), c])
  }
  return out
}

/**
 * The UID of the body event covering each of a bill's calendar rows, by row
 * id. A cancelled event still covers its entries, so a cancellation shows
 * once too. Reads nothing for a provider with no calendar of its own.
 */
export async function calendarCoverage(db: Db, provider: Provider, billId: number, rows: CalendarRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!provider.listBodyEvents || rows.length === 0) return out
  const covers = (await coversByBill(db, provider, [billId])).get(billId) ?? []
  if (covers.length === 0) return out
  for (const row of rows) {
    const cover = chooseCover(calendarKind(provider, row.typeId), row.date, covers)
    if (cover) out.set(row.id, bodyEventUid(provider, cover.eventId))
  }
  return out
}

/** A body event as instances receive it. */
export interface BodyEventDetail {
  uid: string
  state: string
  kind: string
  type: string | null
  date: string
  time: string | null
  timezone: string | null
  committee: { committeeId: string | null; name: string } | null
  jointWith: string | null
  location: string | null
  title: string
  agenda: { topic: string; billNumber: string | null }[]
  url: string | null
  eventHash: string
  cancelled: boolean
  /** The bills on its agenda, by handle. */
  bills: string[]
  /** The bill calendar entries it covers, by bill handle and the identity instances know each by. */
  covers: { billId: string; identityKey: string }[]
}

/**
 * A provider's events in a state from `from` to `to`, as instances receive
 * them, with the bill calendar entries each covers.
 */
export async function bodyEventDetails(db: Db, provider: Provider, state: string, from: string, to: string): Promise<BodyEventDetail[]> {
  const rows = await db.select().from(bodyEvents)
    .where(and(eq(bodyEvents.provider, provider.id), eq(bodyEvents.state, state), gte(bodyEvents.date, from), lte(bodyEvents.date, to)))
    .orderBy(asc(bodyEvents.date), asc(bodyEvents.time), asc(bodyEvents.id)).all()
  if (rows.length === 0) return []

  // Links, to the provider's bills only: a bill since moved to another provider isn't on its calendar.
  const links = new Map<number, number[]>()
  for (const chunk of chunks(rows.map(r => r.id))) {
    const found = await db.select({ eventRow: bodyEventBills.bodyEventId, billId: bodyEventBills.billId })
      .from(bodyEventBills).innerJoin(bills, eq(bills.billId, bodyEventBills.billId))
      .where(and(inArray(bodyEventBills.bodyEventId, chunk), eq(bills.provider, provider.id))).all()
    for (const l of found) links.set(l.eventRow, [...(links.get(l.eventRow) ?? []), l.billId])
  }

  // The entries each event covers: each linked bill's live entries on an event's day.
  const billIds = [...new Set([...links.values()].flat())]
  const covered = new Map<number, { billId: string; identityKey: string }[]>()
  if (billIds.length > 0) {
    const covers = await coversByBill(db, provider, billIds)
    for (const chunk of chunks(billIds)) {
      const entries = await db.select().from(billCalendar)
        .where(and(inArray(billCalendar.billId, chunk), isNull(billCalendar.cancelledAt),
          gte(billCalendar.date, from), lte(billCalendar.date, to))).all()
      for (const entry of entries) {
        const cover = chooseCover(calendarKind(provider, entry.typeId), entry.date, covers.get(entry.billId) ?? [])
        if (!cover) continue
        const list = covered.get(cover.id) ?? []
        const ref = { billId: toHandle(entry.billId), identityKey: sentIdentity(entry) }
        if (!list.some(x => x.billId === ref.billId && x.identityKey === ref.identityKey)) list.push(ref)
        covered.set(cover.id, list)
      }
    }
  }

  const committeeIds = rows.map(r => r.committeeId).filter((id): id is number => !!id)
  const committeeNames = await committeeNamesById(db, committeeIds)
  return rows.map(r => ({
    uid: bodyEventUid(provider, r.eventId),
    state: r.state,
    kind: r.kind,
    type: r.type,
    date: r.date,
    time: r.time,
    timezone: r.timezone,
    committee: r.committeeId || r.committee
      ? { committeeId: r.committeeId && committeeNames.has(r.committeeId) ? String(r.committeeId) : null, name: committeeNames.get(r.committeeId ?? 0) ?? r.committee ?? '' }
      : null,
    jointWith: r.jointWith,
    location: r.location,
    title: r.title,
    agenda: parseAgenda(r.agendaJson),
    url: r.url,
    eventHash: r.eventHash,
    cancelled: !!r.cancelledAt,
    bills: (links.get(r.id) ?? []).sort((a, b) => a - b).map(toHandle),
    covers: covered.get(r.id) ?? [],
  }))
}

async function committeeNamesById(db: Db, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  for (const chunk of chunks([...new Set(ids)])) {
    for (const c of await db.select({ id: committees.committeeId, name: committees.name }).from(committees)
      .where(inArray(committees.committeeId, chunk)).all()) out.set(c.id, c.name)
  }
  return out
}

function parseAgenda(json: string): { topic: string; billNumber: string | null }[] {
  try {
    const items = JSON.parse(json) as unknown
    return Array.isArray(items)
      ? items.filter((i): i is { topic: string; billNumber: string | null } => typeof i?.topic === 'string')
        .map(i => ({ topic: i.topic, billNumber: typeof i.billNumber === 'string' ? i.billNumber : null }))
      : []
  } catch {
    return []
  }
}
