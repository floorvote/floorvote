import { and, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import { associationConfig, bills, calendarEventBills, calendarEvents } from '../db/schema'
import { centralFetch } from './centralFetch'
import { hearingUid } from './hearingUid'
import { nowDb } from './dbTime'
import type { AppDb, Env } from '../types'

/**
 * Body events (#297): the legislature's own calendar of hearings,
 * roundtables, and meetings, with or without bills on the agenda, for the
 * states the instance covers whose provider publishes one (DC's Council
 * calendar, from LIMS). Central keeps the events (central/src/lib/bodyEvents.ts),
 * and an hourly job here mirrors them into calendar_events as source 'body',
 * each under the calendar UID central gives it, with its agenda bills in
 * calendar_event_bills.
 *
 * Central also says which bill calendar entries each event covers: a bill's
 * hearing that the legislature's calendar lists too. Each covered entry's
 * covered_by names the event, and the calendar and ICS feed show the event in
 * its place, so the hearing appears once (lib/calendarVisibility.ts).
 *
 * The same call brings the capabilities of the states the instance covers
 * (`state_capabilities`, which GET /config serves), so features gate on what a
 * state's data can do, not on its name. An instance whose states have no body
 * events asks once a day, in case one gains them.
 */

/** What a covered state's data can do (central/src/lib/capabilities.ts). A state left out has none. */
export interface StateCapabilities {
  bodyEvents: boolean
  deadlines: boolean
}

/** A body event as central sends it (GET /tenants/:tenantId/body-events). */
export interface CentralBodyEvent {
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
  /** The bill calendar entries it covers. */
  covers: { billId: string; identityKey: string }[]
}

export const CAPABILITIES_KEY = 'state_capabilities'
/** How long the capabilities stand when no covered state has body events. */
const CAPABILITIES_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The window mirrored: a month back and four ahead, around the months central reads (last month through three ahead). */
const WINDOW_BACK_DAYS = 31
const WINDOW_AHEAD_DAYS = 124

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

/** The capabilities central last sent, and when, or null before the first sync. */
export async function readStateCapabilities(db: AppDb): Promise<{ data: Record<string, StateCapabilities>; cachedAt: string } | null> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, CAPABILITIES_KEY)).get()
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as { data?: unknown; cachedAt?: unknown }
    if (!parsed.data || typeof parsed.data !== 'object' || typeof parsed.cachedAt !== 'string') return null
    return { data: parsed.data as Record<string, StateCapabilities>, cachedAt: parsed.cachedAt }
  } catch {
    return null
  }
}

/**
 * An event's one-line description: its title and agenda, as the contributor's
 * fork wrote it ("Youth Affairs roundtable: DYRS' Fifth Rulemaking ...").
 */
export function bodyEventDescription(e: Pick<CentralBodyEvent, 'title' | 'agenda'>): string {
  const topics = e.agenda.map(a => a.topic.trim()).filter(t => t && t.toLowerCase() !== e.title.trim().toLowerCase())
  const agenda = topics.length === 0 ? '' : topics.length <= 2 ? `: ${topics.join('; ')}` : `: ${topics[0]}; and ${topics.length - 1} more`
  return `${e.title}${agenda}`
}

/** An event's details: who it's held jointly with, and the whole agenda. */
export function bodyEventDetails(e: Pick<CentralBodyEvent, 'jointWith' | 'agenda'>): string | null {
  const lines = e.agenda.filter(a => a.topic.trim()).map(a => `- ${a.topic.trim()}${a.billNumber ? ` (${a.billNumber})` : ''}`)
  if (e.jointWith) lines.unshift(e.jointWith)
  return lines.length > 0 ? lines.join('\n') : null
}

function chunks<T>(items: readonly T[], size = 80): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface BodyEventSyncResult {
  upserted: number
  cancelled: number
  removed: number
  covered: number
}

/**
 * Mirror the body events of the instance's covered states, and record the
 * capabilities central sends with them. Null when no covered state has body
 * events and the capabilities are less than a day old, so nothing was asked.
 * Throws when central doesn't answer, leaving every event as it was.
 */
export async function syncBodyEvents(env: Env, db: AppDb): Promise<BodyEventSyncResult | null> {
  const known = await readStateCapabilities(db)
  const anyBodyEvents = (caps: Record<string, StateCapabilities> | undefined) => Object.values(caps ?? {}).some(c => c.bodyEvents)
  if (known && !anyBodyEvents(known.data) && Date.now() - Date.parse(known.cachedAt) < CAPABILITIES_MAX_AGE_MS) return null

  const from = isoDay(-WINDOW_BACK_DAYS)
  const to = isoDay(WINDOW_AHEAD_DAYS)
  const res = await centralFetch(env, `/tenants/${env.TENANT_ID}/body-events?from=${from}&to=${to}`)
  if (!res.ok) throw new Error(`central body-events HTTP ${res.status}`)
  const body = await res.json() as { capabilities?: Record<string, StateCapabilities>; events?: CentralBodyEvent[] }
  const events = Array.isArray(body.events) ? body.events : []

  const cache = JSON.stringify({ data: body.capabilities ?? {}, cachedAt: new Date().toISOString() }) // ts-write-ok: cache metadata inside a JSON config blob, never SQL-sorted
  await db.insert(associationConfig).values({ key: CAPABILITIES_KEY, value: cache })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: cache } })

  return reconcileBodyEvents(env, db, events, from, to)
}

/**
 * Make the instance's body events in the window match central's: add and
 * update events (bumping an event's ICS sequence when it changes, is
 * cancelled, or comes back), link their agenda bills, remove events central
 * no longer sends for the instance (a state it stopped covering), and point
 * covered bill entries at their events.
 */
async function reconcileBodyEvents(env: Env, db: AppDb, events: CentralBodyEvent[], from: string, to: string): Promise<BodyEventSyncResult> {
  const now = nowDb()
  const result: BodyEventSyncResult = { upserted: 0, cancelled: 0, removed: 0, covered: 0 }
  const incoming = new Map(events.map(e => [e.uid, e]))

  type Existing = { id: string; uid: string; sequence: number; eventHash: string | null; status: string; source: string; kind: string | null }
  const cols = {
    id: calendarEvents.id, uid: calendarEvents.uid, sequence: calendarEvents.sequence, eventHash: calendarEvents.eventHash,
    status: calendarEvents.status, source: calendarEvents.source, kind: calendarEvents.kind,
  }
  const existing = new Map<string, Existing>()
  for (const r of await db.select(cols).from(calendarEvents)
    .where(and(eq(calendarEvents.source, 'body'), gte(calendarEvents.date, from), lte(calendarEvents.date, to))).all()) existing.set(r.uid, r)
  // An event stored under another date, or another source (a fork's 'council' rows, under the same UIDs).
  for (const chunk of chunks([...incoming.keys()])) {
    for (const r of await db.select(cols).from(calendarEvents).where(inArray(calendarEvents.uid, chunk)).all()) existing.set(r.uid, r)
  }

  // Agenda bills the instance holds, by handle.
  const handles = [...new Set(events.flatMap(e => e.bills))]
  const billByHandle = new Map<string, string>()
  for (const chunk of chunks(handles)) {
    for (const b of await db.select({ id: bills.id, externalId: bills.externalId }).from(bills).where(inArray(bills.externalId, chunk)).all()) {
      if (b.externalId) billByHandle.set(b.externalId, b.id)
    }
  }

  for (const e of incoming.values()) {
    const prior = existing.get(e.uid)
    if (prior && prior.source !== 'body' && prior.source !== 'council') continue
    const status = e.cancelled ? 'cancelled' as const : 'confirmed' as const
    // An event cancelled before the instance ever had it has nothing to tell anyone.
    if (!prior && status === 'cancelled') continue
    const values = {
      source: 'body', billId: null, kind: e.kind, status, coveredBy: null,
      date: e.date, time: e.time, location: e.location,
      description: bodyEventDescription(e), details: bodyEventDetails(e), url: e.url,
      timezone: e.timezone, eventHash: e.eventHash, updatedAt: now,
    }
    let id: string
    if (!prior) {
      id = crypto.randomUUID()
      await db.insert(calendarEvents).values({ id, uid: e.uid, sequence: 0, createdAt: now, ...values })
      result.upserted++
    } else {
      id = prior.id
      const bump = (prior.eventHash ?? '') !== e.eventHash || prior.status !== status
      // The hash covers everything shown, so an unchanged event costs no write.
      if (bump || prior.source !== 'body' || prior.kind !== e.kind) {
        await db.update(calendarEvents).set({ ...values, sequence: bump ? prior.sequence + 1 : prior.sequence })
          .where(eq(calendarEvents.id, id))
      }
      if (bump) {
        if (status === 'cancelled') result.cancelled++
        else result.upserted++
      }
    }
    await relink(db, id, e.bills.map(h => billByHandle.get(h)).filter((b): b is string => !!b))
  }

  // Events central no longer sends for this instance.
  const removed = [...existing.values()].filter(r => r.source === 'body' && !incoming.has(r.uid))
  for (const chunk of chunks(removed.map(r => r.id))) {
    await db.delete(calendarEventBills).where(inArray(calendarEventBills.eventId, chunk))
    await db.delete(calendarEvents).where(inArray(calendarEvents.id, chunk))
  }
  result.removed = removed.length

  result.covered = await pointCovers(env, db, events, new Set(removed.map(r => r.uid)))
  return result
}

/** Point an event's bill links at `billIds`, writing only when they differ. */
async function relink(db: AppDb, eventId: string, billIds: string[]): Promise<void> {
  const current = (await db.select({ billId: calendarEventBills.billId }).from(calendarEventBills)
    .where(eq(calendarEventBills.eventId, eventId)).all()).map(r => r.billId).sort()
  const want = [...new Set(billIds)].sort()
  if (current.length === want.length && current.every((id, i) => id === want[i])) return
  await db.delete(calendarEventBills).where(eq(calendarEventBills.eventId, eventId))
  for (const chunk of chunks(want, 40)) await db.insert(calendarEventBills).values(chunk.map(billId => ({ eventId, billId })))
}

/**
 * Point each covered bill entry at the event covering it, and clear a cover
 * that names one of these events (or a removed one) but no longer holds.
 * Returns how many entries changed.
 */
async function pointCovers(env: Env, db: AppDb, events: CentralBodyEvent[], removedUids: Set<string>): Promise<number> {
  const want = new Map<string, string>()
  for (const e of events) for (const c of e.covers) want.set(hearingUid(c.billId, c.identityKey, env.TENANT_ID), e.uid)
  const known = new Set([...events.map(e => e.uid), ...removedUids])

  const rows = new Map<string, { id: string; uid: string; coveredBy: string | null }>()
  const cols = { id: calendarEvents.id, uid: calendarEvents.uid, coveredBy: calendarEvents.coveredBy }
  for (const r of await db.select(cols).from(calendarEvents)
    .where(and(eq(calendarEvents.source, 'hearing'), isNotNull(calendarEvents.coveredBy))).all()) rows.set(r.uid, r)
  for (const chunk of chunks([...want.keys()])) {
    for (const r of await db.select(cols).from(calendarEvents)
      .where(and(eq(calendarEvents.source, 'hearing'), inArray(calendarEvents.uid, chunk))).all()) rows.set(r.uid, r)
  }

  let changed = 0
  for (const r of rows.values()) {
    const next = want.get(r.uid) ?? (r.coveredBy && known.has(r.coveredBy) ? null : r.coveredBy)
    if (next === r.coveredBy) continue
    await db.update(calendarEvents).set({ coveredBy: next }).where(eq(calendarEvents.id, r.id))
    changed++
  }
  return changed
}
