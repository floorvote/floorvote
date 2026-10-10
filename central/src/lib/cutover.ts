import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { bills, billCalendar, cutoverBills, cutoverPeople, cutovers, people, providerIds, sessions } from '../db/schema'
import {
  DEFAULT_PROVIDER_ID, findProvider,
  type CentralMeasure, type Provider, type ProviderContext, type ProviderPerson, type ProviderRecord, type StoredSession, type SyncSession,
} from '../providers'
import { isSnapshotProvider, sessionValues, type SnapshotProvider } from '../cron/sync-snapshots'
import { carryCalendar, calendarKind, sentIdentity, type CalendarRow } from './billCalendar'
import { billMatchKey, matchPeople, type PeopleMatch, type PersonFacts, type PersonMatch } from './cutoverMatch'
import { providerContext } from './providerContext'
import { providerIdsFor } from './providerIds'
import { providerConfigured } from './providerRouting'
import { ownerOfState } from './stateProviders'
import { assignSessionSlugs } from './sessionSlugs'
import { toHandle } from './billHandle'
import { nowDb } from './dbTime'
import type { Db, Env } from '../types'

/**
 * Cutovers (#296): moving a state that instances already track from its
 * provider to another, without writing to any instance's database.
 *
 * A dry run (`planCutover` alone) reads the new provider's sessions and
 * records, matches them to the state's bills and legislators, previews what
 * happens to each moved bill's calendar, and writes nothing. The cutover
 * (`applyCutover`) plans again, then writes everything in one D1 batch, which
 * is one transaction, with the ownership flip last:
 *
 * - **Bills** are matched on session year, kind of session, and number
 *   (lib/cutoverMatch.ts, from #259's planner). A matched bill keeps its
 *   central row id, so its handle, and every instance's copy of it, stay as
 *   they are. The new provider's key for it maps to that id in
 *   `provider_ids` and `cutover_bills`, the row's provider flips, and it moves
 *   to the new provider's session (often a `-2` slug beside the old one).
 *   Its texts, supplements, amendments, roll calls, and member votes are
 *   cleared, since the ingest upserts those by their own ids and the two
 *   providers' would otherwise mix.
 * - **The first ingest** of each moved bill (queue/processor.ts, flagged by
 *   `bills.carried_from`) sends instances no changes, and carries the bill's
 *   calendar entries over (`carryCalendar`): an entry on the same date and of
 *   the same kind keeps the identity, and so the calendar UID, instances
 *   already have. The rest of the old entries are cancelled once, and the new
 *   provider's other entries arrive as new.
 * - **Legislators** are matched on name, chamber, and district, and keep
 *   their person ids (`cutover_people`, applied by lib/carriedIds.ts).
 * - **The losing provider's sessions** in the state are marked ended, since
 *   nothing syncs them any more.
 * - **Ownership** (`state_providers`) flips in the batch's last statement,
 *   without a claim's refusal check, since a cutover is what moves tracked
 *   bills. If anything fails, nothing is written and the state stays on its
 *   provider.
 *
 * `undoCutover` flips the state back and puts each moved bill back where it
 * was. The previous provider's sync then rewrites the rows, with the same
 * quiet first ingest.
 */

/** A refused or impossible cutover, with the HTTP status the admin route answers. */
export class CutoverError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) {
    super(message)
  }
}

/** One of the new provider's sessions, as it would store it. */
interface NewSession {
  listed: SyncSession
  stored: StoredSession
  special: number
  /** Whether the provider syncs it (`selectSessions`): only those are read and matched. */
  synced: boolean
}

interface OldBill {
  billId: number
  number: string
  sessionId: number
  sessionName: string | null
  yearStart: number
  special: number
  linked: boolean
  tracked: boolean
}

interface NewRecord {
  record: ProviderRecord
  number: string
  session: NewSession
}

/** A bill the cutover moves, under the row id it keeps. */
export interface MovedBill {
  old: OldBill
  next: NewRecord
}

type OldPerson = PersonFacts
type NewPerson = PersonFacts

export interface CalendarPreview {
  bills: number
  kept: { billId: number; number: string; identityKey: string; kind: string; date: string | null; from: string | null; to: string | null }[]
  cancelled: { billId: number; number: string; identityKey: string; kind: string; date: string | null; description: string | null }[]
  added: { billId: number; number: string; kind: string; date: string | null; description: string | null }[]
}

export interface CutoverPlan {
  state: string
  from: Provider
  to: SnapshotProvider
  sessions: NewSession[]
  moved: MovedBill[]
  unmatchedOld: OldBill[]
  unmatchedNew: NewRecord[]
  /** Match keys two bills on one side share, which match neither. */
  ambiguous: { side: 'old' | 'new'; numbers: string[] }[]
  /** Bills the new provider already holds under another row. */
  conflicts: { old: OldBill; next: NewRecord; heldAs: number }[]
  people: PeopleMatch<OldPerson, NewPerson>
  /** The dry run's preview of each moved bill's calendar. */
  calendar: CalendarPreview | null
  /** The losing provider's sessions in the state, and their flags before the cutover. */
  oldSessions: { sessionId: number; prior: number; sineDie: number }[]
  /** How many bills the losing provider had in the state when planning started. */
  oldBillCount: number
  /** Ids the plan handed out for keys with no central id yet, which the cutover mints. */
  provisional: Map<number, { kind: string; key: string }>
}

/** D1 caps a statement's bound value at 2 MB, and a statement at 100 KB. As in lib/rollCallVotes.ts, stay under the smaller. */
const MAX_JSON_CHARS = 60_000
/** Bill ids per read. */
const READ_CHUNK = 5_000

/**
 * The provider context a plan reads with. It writes nothing: `ids` answers
 * from the id table as it stands, and hands out negative placeholders for
 * keys it doesn't hold, which only the cutover mints. A dry run also logs no
 * calls.
 */
async function planContext(provider: Provider, env: Env, db: Db, logCalls: boolean) {
  const base = providerContext(provider, env, db, { reason: 'cutover' })
  const known = new Map<string, number>()
  const rows = await db.select({ kind: providerIds.kind, key: providerIds.nativeKey, id: providerIds.id })
    .from(providerIds).where(eq(providerIds.provider, provider.id)).all()
  for (const r of rows) known.set(`${r.kind}\n${r.key}`, r.id)
  const provisional = new Map<number, { kind: string; key: string }>()
  let next = -1
  let held: ReturnType<ProviderContext['people']> | null = null
  const ctx: ProviderContext = {
    ...base,
    logCall: logCalls ? base.logCall : () => {},
    async ids(kind, keys) {
      const out = new Map<string, number>()
      for (const key of keys) {
        let id = known.get(`${kind}\n${key}`)
        if (id === undefined) {
          id = next--
          known.set(`${kind}\n${key}`, id)
          provisional.set(id, { kind, key })
        }
        out.set(key, id)
      }
      return out
    },
    people: () => (held ??= base.people()),
  }
  return { ctx, provisional }
}

/** The ids, in chunks small enough for one JSON parameter each. */
function idChunks(ids: number[]): string[] {
  const out: string[] = []
  for (let i = 0; i < ids.length; i += READ_CHUNK) out.push(JSON.stringify(ids.slice(i, i + READ_CHUNK)))
  return out
}

/** Rows as JSON arrays, in chunks that each fit one bound parameter. */
function jsonChunks(rows: unknown[][]): string[] {
  const out: string[] = []
  let chunk: unknown[][] = []
  let chars = 2
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1
    if (chunk.length > 0 && chars + size > MAX_JSON_CHARS) {
      out.push(JSON.stringify(chunk))
      chunk = []
      chars = 2
    }
    chunk.push(row)
    chars += size
  }
  if (chunk.length > 0) out.push(JSON.stringify(chunk))
  return out
}

function keyed<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    out.set(k, [...(out.get(k) ?? []), item])
  }
  return out
}

/**
 * Plan a cutover of `state` to provider `toId`. Reads the new provider's feed,
 * and writes nothing.
 */
export async function planCutover(env: Env, db: Db, state: string, toId: string, opts: { dryRun: boolean }): Promise<CutoverPlan> {
  const to = findProvider(toId)
  if (!to) throw new CutoverError(400, `unknown provider "${toId}"`)
  if (!isSnapshotProvider(to)) throw new CutoverError(400, `a cutover moves a state to a provider read as a snapshot, and "${to.id}" isn't one`)
  if (!to.states.includes(state)) throw new CutoverError(400, `provider "${to.id}" serves ${to.states.join(', ')}, not ${state}`)
  if (!providerConfigured(to, env)) throw new CutoverError(400, `provider "${to.id}" is not configured on this central`)
  const owner = await ownerOfState(db, state)
  if (owner === to.id) throw new CutoverError(409, `${state} already syncs from ${to.id}`)
  const from = findProvider(owner)
  if (!from) throw new CutoverError(409, `${state} syncs from "${owner}", which this central doesn't know`)

  const oldBillCount = Number((await db.select({ n: sql<number>`COUNT(*)` }).from(bills)
    .where(and(eq(bills.state, state), eq(bills.provider, from.id))).get())?.n ?? 0)
  const oldSessions = await db.select({ sessionId: sessions.sessionId, prior: sessions.prior, sineDie: sessions.sineDie })
    .from(sessions).where(and(eq(sessions.state, state), eq(sessions.provider, from.id))).all()

  const { ctx, provisional } = await planContext(to, env, db, !opts.dryRun)

  // The new provider's sessions, as its sync would store them, and the ones it would sync.
  const newSessions: NewSession[] = (await to.listSessions(state, ctx)).map(s => ({
    listed: s,
    stored: {
      sessionId: s.session_id, state, sessionTag: s.session_tag ?? '', yearStart: s.year_start, yearEnd: s.year_end,
      sessionName: s.session_name, prior: s.prior ?? 0,
    },
    special: s.special ?? 0,
    synced: false,
  }))
  const syncedIds = new Set(to.selectSessions(newSessions.map(s => s.stored), ctx.today).map(s => s.sessionId))
  for (const s of newSessions) s.synced = syncedIds.has(s.stored.sessionId)
  const synced = newSessions.filter(s => s.synced)
  if (synced.length === 0) throw new CutoverError(502, `${to.id} listed no current session for ${state}, so there's nothing to cut over to`)

  // Every record in those sessions, and any legislators the provider lists.
  const newRecords: NewRecord[] = []
  const listedPeople: ProviderPerson[] = []
  let listsPeople = !!to.listPeople
  for (const session of synced) {
    const snap = await to.snapshot(session.stored, ctx)
    if (snap.people) {
      listsPeople = true
      listedPeople.push(...snap.people)
    }
    for (const record of snap.records) {
      newRecords.push({ record, number: (await to.toEntry(record, { description: null }, ctx)).number, session })
    }
  }
  if (newRecords.length === 0) throw new CutoverError(502, `${to.id} listed no records for ${state}, so there's nothing to cut over to`)
  if (to.listPeople) listedPeople.push(...await to.listPeople(newSessions.map(s => s.stored), ctx))

  // The losing provider's bills in sessions the new provider's could hold.
  // Earlier sessions stay as they are.
  const fromYear = Math.min(...synced.map(s => s.stored.yearStart))
  const oldBills: OldBill[] = (await db.select({
    billId: bills.billId, number: bills.billNumber, sessionId: bills.sessionId,
    sessionName: sessions.sessionName, yearStart: sessions.yearStart, special: sessions.special,
    linked: sql<number>`EXISTS (SELECT 1 FROM bill_tenants bt WHERE bt.bill_id = ${bills.billId})`,
    tracked: sql<number>`EXISTS (SELECT 1 FROM bill_tenants bt WHERE bt.bill_id = ${bills.billId} AND bt.match_type IS NOT NULL)`,
  })
    .from(bills)
    .leftJoin(sessions, eq(sessions.sessionId, bills.sessionId))
    .where(and(eq(bills.state, state), eq(bills.provider, from.id), or(isNull(sessions.sessionId), gte(sessions.yearEnd, fromYear))))
    .all())
    .map(b => ({ ...b, yearStart: b.yearStart ?? 0, special: b.special ?? 0, linked: !!b.linked, tracked: !!b.tracked }))

  // Match on session year, kind of session, and number.
  const ambiguous: CutoverPlan['ambiguous'] = []
  const newByKey = keyed(newRecords, r => billMatchKey({ yearStart: r.session.stored.yearStart, special: r.session.special }, r.number))
  const oldByKey = keyed(oldBills, b => billMatchKey(b, b.number))
  for (const [, group] of newByKey) if (group.length > 1) ambiguous.push({ side: 'new', numbers: group.map(r => r.number) })
  for (const [, group] of oldByKey) if (group.length > 1) ambiguous.push({ side: 'old', numbers: group.map(b => b.number) })
  const pairs: MovedBill[] = []
  for (const [key, group] of oldByKey) {
    const next = newByKey.get(key)
    if (group.length === 1 && next?.length === 1) pairs.push({ old: group[0], next: next[0] })
  }

  // A bill the new provider already holds under another row would be held twice.
  const produced = pairs.map(p => p.next.record.billId).filter(id => id > 0)
  const existing = new Set<number>()
  for (const chunk of idChunks(produced)) {
    for (const r of await db.select({ billId: bills.billId }).from(bills)
      .where(sql`${bills.billId} IN (SELECT value FROM json_each(${chunk}))`).all()) existing.add(r.billId)
  }
  const conflicts: CutoverPlan['conflicts'] = []
  const moved: MovedBill[] = []
  for (const p of pairs) {
    const heldAs = p.next.record.billId
    if (heldAs !== p.old.billId && existing.has(heldAs)) conflicts.push({ ...p, heldAs })
    else moved.push(p)
  }
  const movedOld = new Set(moved.map(m => m.old.billId))
  const movedNew = new Set(moved.map(m => m.next.record))
  const unmatchedOld = oldBills.filter(b => !movedOld.has(b.billId))
  const unmatchedNew = newRecords.filter(r => !movedNew.has(r.record))

  // The measures a plan reads: for the dry run's calendar preview, each moved
  // bill with live calendar entries, and, when the provider lists no
  // legislators of its own (Maryland names them only on its bills), each
  // tracked moved bill, for its sponsors.
  const now = nowDb()
  const liveRows = new Map<number, CalendarRow[]>()
  if (opts.dryRun) {
    for (const chunk of idChunks(moved.map(m => m.old.billId))) {
      const rows = await db.select().from(billCalendar)
        .where(and(isNull(billCalendar.cancelledAt), sql`${billCalendar.billId} IN (SELECT value FROM json_each(${chunk}))`)).all()
      for (const r of rows) liveRows.set(r.billId, [...(liveRows.get(r.billId) ?? []), r])
    }
  }
  const measures = new Map<number, CentralMeasure>()
  for (const m of moved) {
    if (!liveRows.has(m.old.billId) && (listsPeople || !m.old.tracked)) continue
    const fetched = await to.fetchMeasure({
      billId: m.old.billId,
      sessionId: m.next.session.stored.sessionId,
      nativeKey: m.next.record.nativeKey,
      record: { raw: m.next.record.raw, hash: m.next.record.hash },
      session: m.next.session.stored,
    }, ctx)
    measures.set(m.old.billId, 'measure' in fetched ? fetched.measure : fetched)
  }

  let calendar: CalendarPreview | null = null
  if (opts.dryRun) {
    calendar = { bills: 0, kept: [], cancelled: [], added: [] }
    for (const m of moved) {
      const rows = liveRows.get(m.old.billId)
      const measure = measures.get(m.old.billId)
      // A measure with no calendar at all says nothing about the entries, and its carry-over waits for one that does.
      if (!rows || !measure?.calendar) continue
      calendar.bills++
      const carry = carryCalendar(from, to, rows, measure.calendar, now)
      const bill = { billId: m.old.billId, number: m.old.number }
      for (const k of carry.kept) {
        calendar.kept.push({ ...bill, identityKey: k.identityKey, kind: calendarKind(to, k.row.typeId), date: k.row.date, from: k.before.description, to: k.row.description })
      }
      for (const r of carry.cancelled) {
        calendar.cancelled.push({ ...bill, identityKey: sentIdentity(r), kind: calendarKind(from, r.typeId), date: r.date, description: r.description })
      }
      for (const e of carry.added) {
        calendar.added.push({ ...bill, kind: calendarKind(to, e.type_id || null), date: e.date || null, description: e.description || null })
      }
    }
  }

  // Legislators: the losing provider's for the state, against the new
  // provider's listings and the sponsors of the measures read above.
  const oldPeople: OldPerson[] = await db.select({
    id: people.peopleId, name: people.name, firstName: people.firstName, lastName: people.lastName,
    role: people.role, roleId: people.roleId, district: people.district,
  })
    .from(people)
    .where(and(eq(people.provider, from.id), inArray(people.stateId,
      db.selectDistinct({ stateId: bills.stateId }).from(bills)
        .where(and(eq(bills.state, state), eq(bills.provider, from.id), gt(bills.stateId, 0))))))
    .all()
  const newPeople = new Map<number, NewPerson>()
  for (const p of listedPeople) {
    newPeople.set(p.people_id, { id: p.people_id, name: p.name, firstName: p.first_name, lastName: p.last_name, role: p.role, roleId: p.role_id })
  }
  for (const measure of measures.values()) {
    for (const s of measure.sponsors ?? []) {
      if (!s.people_id) continue
      const known = newPeople.get(s.people_id)
      newPeople.set(s.people_id, known
        ? { ...known, district: known.district || s.district || null }
        : { id: s.people_id, name: s.name, firstName: s.first_name, lastName: s.last_name, role: s.role, roleId: s.role_id, district: s.district || null })
    }
  }
  const matchedPeople = matchPeople(oldPeople, [...newPeople.values()])
  // A person the new provider already has a row for would be held twice.
  const heldPeople = new Set<number>()
  for (const chunk of idChunks(matchedPeople.matched.map(m => m.to.id).filter(id => id > 0))) {
    for (const r of await db.select({ id: people.peopleId }).from(people)
      .where(and(eq(people.provider, to.id), sql`${people.peopleId} IN (SELECT value FROM json_each(${chunk}))`)).all()) heldPeople.add(r.id)
  }
  const kept: PersonMatch<OldPerson, NewPerson>[] = []
  for (const m of matchedPeople.matched) {
    if (m.to.id !== m.from.id && heldPeople.has(m.to.id)) {
      matchedPeople.unmatchedFrom.push(m.from)
      matchedPeople.unmatchedTo.push(m.to)
    } else {
      kept.push(m)
    }
  }

  return {
    state, from, to,
    sessions: newSessions,
    moved, unmatchedOld, unmatchedNew, ambiguous, conflicts,
    people: { ...matchedPeople, matched: kept },
    calendar,
    oldSessions,
    oldBillCount,
    provisional,
  }
}

/**
 * Delete bills' texts, supplements, amendments, roll calls, and member votes:
 * what the ingest upserts by their own ids rather than replacing. `billIds` is
 * a subquery of bill ids, with its bindings.
 */
function clearStatements(d1: D1Database, billIds: string, binds: unknown[]): D1PreparedStatement[] {
  return [
    `DELETE FROM roll_call_votes WHERE roll_call_id IN (SELECT roll_call_id FROM roll_calls WHERE bill_id IN (${billIds}))`,
    `DELETE FROM roll_calls WHERE bill_id IN (${billIds})`,
    `DELETE FROM bill_texts WHERE bill_id IN (${billIds})`,
    `DELETE FROM bill_supplements WHERE bill_id IN (${billIds})`,
    `DELETE FROM bill_amendments WHERE bill_id IN (${billIds})`,
  ].map(q => d1.prepare(q).bind(...binds))
}

/**
 * Clear what a bill's previous provider wrote that the ingest wouldn't
 * replace, in one batch. The first ingest after a cutover runs it again, in
 * case an ingest from the previous provider was already under way.
 */
export async function clearProviderData(d1: D1Database, billIds: number[]): Promise<void> {
  if (billIds.length === 0) return
  await d1.batch(clearStatements(d1, 'SELECT value FROM json_each(?)', [JSON.stringify(billIds)]))
}

/** Central ids for the plan's placeholders, minted now: the new provider's sessions and the people matched. */
async function mintPlaceholders(db: Db, plan: CutoverPlan, wanted: number[]): Promise<Map<number, number>> {
  const byKind = new Map<string, { placeholder: number; key: string }[]>()
  for (const id of new Set(wanted)) {
    const p = plan.provisional.get(id)
    if (!p) continue
    byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), { placeholder: id, key: p.key }])
  }
  const real = new Map<number, number>()
  for (const [kind, list] of byKind) {
    const ids = await providerIdsFor(db, plan.to.id, kind, list.map(l => l.key))
    for (const l of list) real.set(l.placeholder, ids.get(l.key)!)
  }
  return real
}

/**
 * Carry out a plan made with `dryRun: false`. Everything is written in one
 * batch, so it all lands or none of it does, and the ownership flip is its
 * last statement. Returns the cutover's id.
 */
export async function applyCutover(env: Env, db: Db, plan: CutoverPlan): Promise<{ id: string }> {
  const { state, from, to } = plan
  const real = await mintPlaceholders(db, plan, [
    ...plan.sessions.map(s => s.listed.session_id),
    ...plan.people.matched.map(m => m.to.id),
  ])
  const realId = (id: number) => (id < 0 ? real.get(id)! : id)

  const d1 = env.DB
  const id = crypto.randomUUID()
  // Every statement after the first writes only if the first did: while the
  // state still has the provider the plan read, and that provider has added
  // no bills there since.
  const stmts: D1PreparedStatement[] = [
    d1.prepare(`
      INSERT INTO cutovers (id, state, from_provider, to_provider, sessions_json)
      SELECT ?1, ?2, ?3, ?4, ?5
      WHERE COALESCE((SELECT provider FROM state_providers WHERE state = ?2), ?6) = ?3
        AND (SELECT COUNT(*) FROM bills WHERE state = ?2 AND provider = ?3) = ?7`)
      .bind(id, state, from.id, to.id, JSON.stringify(plan.oldSessions), DEFAULT_PROVIDER_ID, plan.oldBillCount),
    ...jsonChunks(plan.moved.map(m => [m.old.billId, m.next.record.nativeKey, m.old.sessionId, realId(m.next.session.stored.sessionId)]))
      .map(json => d1.prepare(`
        INSERT INTO cutover_bills (cutover_id, bill_id, native_key, from_session_id, to_session_id)
        SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
        FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM cutovers WHERE id = ?1)`).bind(id, json)),
    ...jsonChunks(plan.people.matched.map(m => [m.from.id, realId(m.to.id), m.on.join(','), m.weak ? 1 : 0]))
      .map(json => d1.prepare(`
        INSERT INTO cutover_people (cutover_id, people_id, provider_people_id, matched_on, weak)
        SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
        FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM cutovers WHERE id = ?1)`).bind(id, json)),
    // The new provider's key for each bill names its kept id, so a provider
    // that mints ids from the table (Maryland, Virginia) gives that id too,
    // in its records and wherever it refers to the bill. An id or key the
    // table already holds is left alone: lib/carriedIds.ts covers those.
    d1.prepare(`
      INSERT INTO provider_ids (id, provider, kind, native_key)
      SELECT cb.bill_id, ?2, 'bill', cb.native_key FROM cutover_bills cb
      WHERE cb.cutover_id = ?1
        AND NOT EXISTS (SELECT 1 FROM provider_ids p WHERE p.id = cb.bill_id)
        AND NOT EXISTS (SELECT 1 FROM provider_ids p WHERE p.provider = ?2 AND p.kind = 'bill' AND p.native_key = cb.native_key)`)
      .bind(id, to.id),
    // The new provider's sessions, as its session refresh writes them.
    ...plan.sessions.map(s => {
      const v = sessionValues(to.id, state, { ...s.listed, session_id: realId(s.listed.session_id) })
      return d1.prepare(`
        INSERT INTO sessions (session_id, state, state_id, year_start, year_end, prefile, sine_die, prior, special, session_tag, session_title, session_name, provider)
        SELECT ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14 WHERE EXISTS (SELECT 1 FROM cutovers WHERE id = ?1)
        ON CONFLICT (session_id) DO UPDATE SET session_title = excluded.session_title, session_name = excluded.session_name,
          prior = excluded.prior, sine_die = excluded.sine_die`)
        .bind(id, v.sessionId, v.state, v.stateId, v.yearStart, v.yearEnd, v.prefile, v.sineDie, v.prior, v.special,
          v.sessionTag, v.sessionTitle, v.sessionName, v.provider)
    }),
    // Each moved bill: its new provider and session. Its rows still hold the
    // old provider's data until the new provider's first ingest.
    d1.prepare(`
      UPDATE bills SET provider = ?2, carried_from = COALESCE(carried_from, ?3),
        session_id = (SELECT to_session_id FROM cutover_bills WHERE cutover_id = ?1 AND bill_id = bills.bill_id)
      WHERE bill_id IN (SELECT bill_id FROM cutover_bills WHERE cutover_id = ?1) AND provider = ?3`)
      .bind(id, to.id, from.id),
    ...clearStatements(d1, 'SELECT bill_id FROM cutover_bills WHERE cutover_id = ?', [id]),
    // Nothing syncs the losing provider's sessions in the state any more.
    d1.prepare(`UPDATE sessions SET prior = 1, sine_die = 1 WHERE state = ?2 AND provider = ?3 AND EXISTS (SELECT 1 FROM cutovers WHERE id = ?1)`)
      .bind(id, state, from.id),
    // Last, the ownership flip, with no claim's refusal check.
    d1.prepare(`
      INSERT INTO state_providers (state, provider, status, previous_provider, claimed_at)
      SELECT ?2, ?3, 'active', ?4, datetime('now') WHERE EXISTS (SELECT 1 FROM cutovers WHERE id = ?1)
      ON CONFLICT (state) DO UPDATE SET provider = excluded.provider, status = excluded.status,
        previous_provider = excluded.previous_provider, claimed_at = excluded.claimed_at
      WHERE state_providers.provider = ?4`)
      .bind(id, state, to.id, from.id),
  ]
  await d1.batch(stmts)

  const written = await db.select({ id: cutovers.id }).from(cutovers).where(eq(cutovers.id, id)).get()
  if (!written) {
    throw new CutoverError(409, `${state} changed while the cutover was planned (its provider changed, or ${from.id} added bills there). ` +
      'Nothing was written. Run it again.')
  }
  console.log(`[cutover] ${state} moved from ${from.id} to ${to.id} (${id}): ${plan.moved.length} bills, ${plan.people.matched.length} people`)
  // The new sessions' slugs. Every cron tick does this too, so a failure here only waits for the next.
  try {
    await assignSessionSlugs(db)
  } catch (err) {
    console.error('[cutover] assigning session slugs failed; the next cron tick will:', err)
  }
  return { id }
}

/** The cutover an undo would reverse: the state's latest that hasn't been undone. */
export interface UndoPlan {
  cutover: typeof cutovers.$inferSelect
  from: Provider
  to: Provider
  bills: number
  people: number
  /** Bills the provider being undone added in the state, which stay with it. */
  added: number
}

export async function planUndo(env: Env, db: Db, state: string): Promise<UndoPlan> {
  const cutover = await db.select().from(cutovers)
    .where(and(eq(cutovers.state, state), isNull(cutovers.undoneAt)))
    .orderBy(desc(cutovers.createdAt), desc(sql`rowid`)).limit(1).get()
  if (!cutover) throw new CutoverError(404, `${state} has no cutover to undo`)
  const owner = await ownerOfState(db, state)
  if (owner !== cutover.toProvider) {
    throw new CutoverError(409, `${state} syncs from ${owner}, not ${cutover.toProvider}, which its latest cutover moved it to`)
  }
  const from = findProvider(cutover.fromProvider)
  const to = findProvider(cutover.toProvider)
  if (!from || !to) throw new CutoverError(409, `the cutover names a provider this central doesn't know`)
  if (!providerConfigured(from, env)) throw new CutoverError(400, `provider "${from.id}" is not configured on this central`)
  const count = async (q: Promise<{ n: number } | undefined>) => Number((await q)?.n ?? 0)
  return {
    cutover, from, to,
    bills: await count(db.select({ n: sql<number>`COUNT(*)` }).from(cutoverBills).where(eq(cutoverBills.cutoverId, cutover.id)).get()),
    people: await count(db.select({ n: sql<number>`COUNT(*)` }).from(cutoverPeople).where(eq(cutoverPeople.cutoverId, cutover.id)).get()),
    added: await count(db.select({ n: sql<number>`COUNT(*)` }).from(bills)
      .where(and(eq(bills.state, state), eq(bills.provider, to.id),
        sql`${bills.billId} NOT IN (SELECT bill_id FROM cutover_bills WHERE cutover_id = ${cutover.id})`)).get()),
  }
}

/**
 * Undo a cutover: the state goes back to its previous provider, each moved
 * bill to its old session, and the previous provider's sessions to how they
 * were. Each moved bill's data is cleared again, and its next ingest from the
 * previous provider is quiet too. In one batch, like the cutover.
 */
export async function applyUndo(env: Env, db: Db, plan: UndoPlan): Promise<void> {
  const { cutover, from, to } = plan
  const d1 = env.DB
  const id = cutover.id
  const undone = 'EXISTS (SELECT 1 FROM cutovers WHERE id = ?1 AND undone_at IS NOT NULL)'
  const oldSessions = JSON.parse(cutover.sessionsJson) as CutoverPlan['oldSessions']
  await d1.batch([
    d1.prepare(`
      UPDATE cutovers SET undone_at = datetime('now')
      WHERE id = ?1 AND undone_at IS NULL AND COALESCE((SELECT provider FROM state_providers WHERE state = ?2), ?3) = ?4`)
      .bind(id, cutover.state, DEFAULT_PROVIDER_ID, to.id),
    // A bill the new provider never ingested still holds the old provider's
    // data, so it keeps carried_from as it is.
    d1.prepare(`
      UPDATE bills SET provider = ?2, carried_from = COALESCE(carried_from, ?3),
        session_id = (SELECT from_session_id FROM cutover_bills WHERE cutover_id = ?1 AND bill_id = bills.bill_id)
      WHERE bill_id IN (SELECT bill_id FROM cutover_bills WHERE cutover_id = ?1) AND provider = ?3 AND ${undone}`)
      .bind(id, from.id, to.id),
    ...clearStatements(d1,
      `SELECT bill_id FROM cutover_bills WHERE cutover_id = ? AND EXISTS (SELECT 1 FROM cutovers c WHERE c.id = cutover_bills.cutover_id AND c.undone_at IS NOT NULL)`,
      [id]),
    ...oldSessions.map(s => d1.prepare(`UPDATE sessions SET prior = ?2, sine_die = ?3 WHERE session_id = ?4 AND ${undone}`)
      .bind(id, s.prior, s.sineDie, s.sessionId)),
    d1.prepare(`UPDATE sessions SET prior = 1, sine_die = 1 WHERE state = ?2 AND provider = ?3 AND ${undone}`)
      .bind(id, cutover.state, to.id),
    d1.prepare(`UPDATE people SET provider = ?2 WHERE people_id IN (SELECT people_id FROM cutover_people WHERE cutover_id = ?1) AND provider = ?3 AND ${undone}`)
      .bind(id, from.id, to.id),
    d1.prepare(`
      UPDATE state_providers SET provider = ?3, status = 'active', previous_provider = ?4, claimed_at = datetime('now')
      WHERE state = ?2 AND provider = ?4 AND ${undone}`)
      .bind(id, cutover.state, from.id, to.id),
  ])
  const row = await db.select({ undoneAt: cutovers.undoneAt }).from(cutovers).where(eq(cutovers.id, id)).get()
  if (!row?.undoneAt) {
    throw new CutoverError(409, `${cutover.state} changed provider before the undo could run. Nothing was written.`)
  }
  console.log(`[cutover] undid ${id}: ${cutover.state} is back on ${from.id}, ${plan.bills} bills moved back`)
}

/** What the admin routes answer for a plan. */
export function cutoverReport(plan: CutoverPlan) {
  const sessionName = new Map<number, string>(plan.sessions.map(s => [s.stored.sessionId, s.stored.sessionName]))
  const tracked = (b: OldBill) => b.tracked
  return {
    state: plan.state,
    from: plan.from.id,
    to: plan.to.id,
    sessions: plan.sessions.filter(s => s.synced).map(s => s.stored.sessionName),
    bills: {
      matched: plan.moved.length,
      tracked: plan.moved.filter(m => tracked(m.old)).length,
      list: plan.moved.map(m => ({
        billId: toHandle(m.old.billId), number: m.old.number, nativeKey: m.next.record.nativeKey,
        from: m.old.sessionName, to: sessionName.get(m.next.session.stored.sessionId) ?? null, tracked: m.old.tracked,
      })),
      // The losing provider's bills nothing matched stay with it, and nothing syncs them any more.
      unmatched: {
        old: plan.unmatchedOld.map(b => ({ billId: toHandle(b.billId), number: b.number, session: b.sessionName, tracked: b.tracked, linked: b.linked })),
        new: plan.unmatchedNew.map(r => ({ nativeKey: r.record.nativeKey, number: r.number, session: r.session.stored.sessionName })),
      },
      ambiguous: plan.ambiguous,
      conflicts: plan.conflicts.map(c => ({ billId: toHandle(c.old.billId), number: c.old.number, heldAs: toHandle(c.heldAs) })),
    },
    calendar: plan.calendar && {
      ...plan.calendar,
      kept: plan.calendar.kept.map(k => ({ ...k, billId: toHandle(k.billId) })),
      cancelled: plan.calendar.cancelled.map(k => ({ ...k, billId: toHandle(k.billId) })),
      added: plan.calendar.added.map(k => ({ ...k, billId: toHandle(k.billId) })),
    },
    people: {
      matched: plan.people.matched.length,
      weak: plan.people.matched.filter(m => m.weak).length,
      list: plan.people.matched.map(m => ({ personId: String(m.from.id), name: m.from.name, as: m.to.name, nameMatch: m.name, on: m.on, weak: m.weak })),
      ambiguous: plan.people.ambiguous.map(a => ({ name: a.person.name, candidates: a.candidates.map(c => ({ personId: String(c.id), name: c.name })) })),
      unmatched: {
        old: plan.people.unmatchedFrom.map(p => ({ personId: String(p.id), name: p.name })),
        new: plan.people.unmatchedTo.map(p => ({ name: p.name })),
      },
    },
  }
}

export function undoReport(plan: UndoPlan) {
  return {
    cutover: plan.cutover.id,
    state: plan.cutover.state,
    // The undo's direction: back from the provider the cutover moved the state to.
    from: plan.to.id,
    to: plan.from.id,
    cutAt: plan.cutover.createdAt,
    bills: plan.bills,
    people: plan.people,
    added: plan.added,
  }
}
