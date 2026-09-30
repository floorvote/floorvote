import { and, eq, gte, inArray, isNotNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { associationConfig, bills, calendarEventBills, calendarEvents, deepAnalyses, teamLinks } from '../db/schema'
import { centralFetch } from './centralFetch'
import { readConfigString } from './configValue'
import { nowDb } from './dbTime'
import { ASSOCIATION_NAME_PLACEHOLDER, buildDefaultAiContext, isAiConfigDefault } from '../../../shared/aiDefaults'
import { DEEP_PROMPT_VERSION, billInstructions, hearingInstructions, type DeepKind } from '../../../shared/deepAnalysis'
import type { AppDb, Env } from '../types'

/**
 * The deep-analysis queue (see migration 0071). FloorVote decides what needs a
 * deep analysis or a hearing brief and serves each request's input; an external
 * worker writes the result (routes/deepApi.ts). Off unless the operator sets
 * DEEP_ANALYSIS_ENABLED = "true".
 *
 * A request is `auto` (the hourly sweep or a priority change made it) or was
 * asked for by an admin. Auto requests follow eligibility: a bill at an
 * automatic priority with text, or a Council event in the next
 * HEARING_BRIEF_DAYS_AHEAD days. When a subject stops being eligible, its
 * waiting auto request is withdrawn. Hearing briefs cover Council events only:
 * a custom event is the team's own free text, which stays with the team.
 */
export function deepEnabled(env: Env): boolean {
  return env.DEEP_ANALYSIS_ENABLED === 'true'
}

/** Priorities that get a deep analysis automatically. DEEP_ANALYSIS_PRIORITIES, default "high,medium". */
export function deepPriorities(env: Env): string[] {
  const raw = (env.DEEP_ANALYSIS_PRIORITIES ?? '').trim()
  const list = (raw || 'high,medium').split(',').map(s => s.trim()).filter(s => ['high', 'medium', 'low'].includes(s))
  return list.length > 0 ? list : ['high', 'medium']
}

/** Hearing briefs are prepared for Council events this many days ahead. */
export const HEARING_BRIEF_DAYS_AHEAD = 10
/** A claim older than this is treated as abandoned and offered again. */
export const CLAIM_LEASE_MINUTES = 60
/** Claims of one input before the request is marked failed. */
export const MAX_ATTEMPTS = 3
/** A failed request is offered again after this long, while attempts remain. */
const ERROR_RETRY_HOURS = 6
const WRITE_BATCH = 50
const ID_CHUNK = 80

type DeepRow = typeof deepAnalyses.$inferSelect

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

const leaseExpired = sql`${deepAnalyses.claimedAt} < datetime('now', ${`-${CLAIM_LEASE_MINUTES} minutes`})`

/** A request a worker can take: pending, or claimed past the lease, with attempts left. */
export const openRequest: SQL = and(
  lt(deepAnalyses.attempts, MAX_ATTEMPTS),
  or(eq(deepAnalyses.status, 'pending'), and(eq(deepAnalyses.status, 'claimed'), leaseExpired)),
)!

const inFlight = (r: Pick<DeepRow, 'status'>) => r.status === 'pending' || r.status === 'claimed'

function billHash(b: { title: string; textHash: string | null }, links: string[] = []): Promise<string> {
  return sha256(`bill|v${DEEP_PROMPT_VERSION}|${b.textHash ?? ''}|${b.title}|${[...links].sort().join(',')}`)
}

/** Team document URLs per subject, for the input hashes: a new letter means a new analysis. */
async function linkUrls(db: AppDb, kind: 'bill' | 'event', ids?: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const add = (rows: { subjectId: string; url: string }[]) => {
    for (const r of rows) out.set(r.subjectId, [...(out.get(r.subjectId) ?? []), r.url])
  }
  if (!ids) {
    add(await db.select({ subjectId: teamLinks.subjectId, url: teamLinks.url }).from(teamLinks).where(eq(teamLinks.subjectKind, kind)).all())
  } else {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      add(await db.select({ subjectId: teamLinks.subjectId, url: teamLinks.url }).from(teamLinks)
        .where(and(eq(teamLinks.subjectKind, kind), inArray(teamLinks.subjectId, ids.slice(i, i + ID_CHUNK)))).all())
    }
  }
  return out
}

/** Bills linked to an event, drafts excluded: a draft is the team's own and never leaves it. */
async function linkedBills(db: AppDb, eventId: string) {
  const viaJoin = await db.select({ id: bills.id, textHash: bills.lastAiTextHash })
    .from(calendarEventBills).innerJoin(bills, eq(bills.id, calendarEventBills.billId))
    .where(and(eq(calendarEventBills.eventId, eventId), eq(bills.isDraft, false))).all()
  const direct = await db.select({ id: bills.id, textHash: bills.lastAiTextHash })
    .from(calendarEvents).innerJoin(bills, eq(bills.id, calendarEvents.billId))
    .where(and(eq(calendarEvents.id, eventId), eq(bills.isDraft, false))).all()
  const seen = new Set<string>()
  return [...viaJoin, ...direct].filter(b => !seen.has(b.id) && !!seen.add(b.id))
}

async function hearingHash(db: AppDb, e: { id: string; eventHash: string | null; date: string | null; description: string | null }): Promise<string> {
  const linked = (await linkedBills(db, e.id)).map(b => `${b.id}:${b.textHash ?? ''}`).sort().join(',')
  const docs = ((await linkUrls(db, 'event', [e.id])).get(e.id) ?? []).sort().join(',')
  return sha256(`hearing|v${DEEP_PROMPT_VERSION}|${e.eventHash ?? ''}|${e.date ?? ''}|${e.description ?? ''}|${linked}|${docs}`)
}

/**
 * The write (if any) that brings a subject's request up to date with `inputHash`.
 * New subject: a pending row. Changed input, or `force` on a finished row: back
 * to pending, attempts reset, old content kept until the new result arrives.
 */
function planRequest(
  db: AppDb, kind: DeepKind, subjectId: string, inputHash: string, row: DeepRow | undefined,
  opts: { force?: boolean; requestedBy?: string } = {},
) {
  // A request keeps its owner: an admin's request stays theirs when its input
  // changes, so the sweep's eligibility rules never withdraw it.
  const requestedBy = opts.requestedBy ?? row?.requestedBy ?? 'auto'
  if (!row) {
    return db.insert(deepAnalyses).values({ id: crypto.randomUUID(), kind, subjectId, inputHash, requestedBy, requestedAt: nowDb() }).onConflictDoNothing()
  }
  if (row.inputHash === inputHash && (!opts.force || inFlight(row))) return null
  return db.update(deepAnalyses).set({
    status: 'pending', inputHash, requestedBy, requestedAt: nowDb(), claimedAt: null, claimedBy: null, error: null, attempts: 0,
  }).where(eq(deepAnalyses.id, row.id))
}

/**
 * Take a waiting auto request back. A row with earlier content returns to that
 * content, finished; a row without any is deleted.
 */
function planWithdraw(db: AppDb, row: DeepRow) {
  if (row.content && row.contentInputHash) {
    return db.update(deepAnalyses).set({ status: 'done', inputHash: row.contentInputHash, claimedAt: null, claimedBy: null, error: null, attempts: 0 })
      .where(and(eq(deepAnalyses.id, row.id), eq(deepAnalyses.inputHash, row.inputHash)))
  }
  return db.delete(deepAnalyses).where(and(eq(deepAnalyses.id, row.id), eq(deepAnalyses.inputHash, row.inputHash)))
}

async function runBatched(db: AppDb, writes: BatchItem<'sqlite'>[]): Promise<void> {
  for (let i = 0; i < writes.length; i += WRITE_BATCH) {
    const chunk = writes.slice(i, i + WRITE_BATCH)
    await db.batch(chunk as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  }
}

async function rowsFor(db: AppDb, kind: DeepKind, subjectIds?: string[]): Promise<DeepRow[]> {
  if (!subjectIds) return db.select().from(deepAnalyses).where(eq(deepAnalyses.kind, kind)).all()
  const out: DeepRow[] = []
  for (let i = 0; i < subjectIds.length; i += ID_CHUNK) {
    out.push(...await db.select().from(deepAnalyses)
      .where(and(eq(deepAnalyses.kind, kind), inArray(deepAnalyses.subjectId, subjectIds.slice(i, i + ID_CHUNK)))).all())
  }
  return out
}

/**
 * Bring auto bill requests in line with priorities, for every bill or for
 * `billIds`. A handful of reads and batched writes, whatever the count.
 */
export async function syncBillRequests(env: Env, db: AppDb, billIds?: string[]): Promise<{ requested: number; withdrawn: number }> {
  const prios = deepPriorities(env) as ('high' | 'medium' | 'low')[]
  const cols = { id: bills.id, title: bills.title, textHash: bills.lastAiTextHash, priority: bills.priority, isDraft: bills.isDraft }
  const eligibleWhere = and(inArray(bills.priority, prios), eq(bills.isDraft, false), isNotNull(bills.lastAiTextHash))
  let eligible: { id: string; title: string; textHash: string | null }[] = []
  if (billIds) {
    for (let i = 0; i < billIds.length; i += ID_CHUNK) {
      eligible.push(...await db.select(cols).from(bills).where(and(inArray(bills.id, billIds.slice(i, i + ID_CHUNK)), eligibleWhere)).all())
    }
  } else {
    eligible = await db.select(cols).from(bills).where(eligibleWhere).all()
  }
  const rows = await rowsFor(db, 'bill', billIds)
  const rowBy = new Map(rows.map(r => [r.subjectId, r]))
  const eligibleIds = new Set(eligible.map(b => b.id))
  const links = await linkUrls(db, 'bill', billIds)
  const writes: BatchItem<'sqlite'>[] = []
  let requested = 0, withdrawn = 0
  for (const b of eligible) {
    const w = planRequest(db, 'bill', b.id, await billHash(b, links.get(b.id)), rowBy.get(b.id))
    if (w) { writes.push(w); requested++ }
  }
  for (const r of rows) {
    if (r.requestedBy === 'auto' && inFlight(r) && !eligibleIds.has(r.subjectId)) { writes.push(planWithdraw(db, r)); withdrawn++ }
  }
  await runBatched(db, writes)
  return { requested, withdrawn }
}

async function syncHearingRequests(db: AppDb): Promise<{ requested: number; withdrawn: number }> {
  const events = await db.select({ id: calendarEvents.id, eventHash: calendarEvents.eventHash, date: calendarEvents.date, description: calendarEvents.description })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.source, 'council'), eq(calendarEvents.status, 'confirmed'),
      gte(calendarEvents.date, isoDay(0)), lte(calendarEvents.date, isoDay(HEARING_BRIEF_DAYS_AHEAD))))
    .all()
  const rows = await rowsFor(db, 'hearing')
  const rowBy = new Map(rows.map(r => [r.subjectId, r]))
  const eligibleIds = new Set(events.map(e => e.id))
  const writes: BatchItem<'sqlite'>[] = []
  let requested = 0, withdrawn = 0
  for (const e of events) {
    const w = planRequest(db, 'hearing', e.id, await hearingHash(db, e), rowBy.get(e.id))
    if (w) { writes.push(w); requested++ }
  }
  for (const r of rows) {
    if (r.requestedBy === 'auto' && inFlight(r) && !eligibleIds.has(r.subjectId)) { writes.push(planWithdraw(db, r)); withdrawn++ }
  }
  await runBatched(db, writes)
  return { requested, withdrawn }
}

/**
 * Hourly: sync bill and hearing requests, offer failed requests again after a
 * wait while attempts remain, and mark requests out of attempts as failed.
 */
export async function reconcileDeepRequests(env: Env, db: AppDb): Promise<{ bills: number; hearings: number; withdrawn: number } | null> {
  if (!deepEnabled(env)) return null
  const b = await syncBillRequests(env, db)
  const h = await syncHearingRequests(db)
  await db.update(deepAnalyses).set({ status: 'pending', error: null })
    .where(and(eq(deepAnalyses.status, 'error'), lt(deepAnalyses.attempts, MAX_ATTEMPTS),
      sql`${deepAnalyses.completedAt} < datetime('now', ${`-${ERROR_RETRY_HOURS} hours`})`))
  await db.update(deepAnalyses).set({ status: 'error', error: `Gave up after ${MAX_ATTEMPTS} attempts.`, completedAt: nowDb() })
    .where(and(eq(deepAnalyses.status, 'claimed'), leaseExpired, sql`${deepAnalyses.attempts} >= ${MAX_ATTEMPTS}`))
  return { bills: b.requested, hearings: h.requested, withdrawn: b.withdrawn + h.withdrawn }
}

/** After a priority change: request, or withdraw, the auto analyses of these bills. */
export async function requestDeepForPrioritized(env: Env, db: AppDb, billIds: string[]): Promise<void> {
  if (!deepEnabled(env) || billIds.length === 0) return
  await syncBillRequests(env, db, billIds)
}

/**
 * An admin's request for one subject: a non-draft bill, or a Council event.
 * Returns the row's status and whether this call created or reset it, or null
 * when the subject cannot be analysed.
 */
export async function ensureDeepRequest(
  db: AppDb, kind: DeepKind, subjectId: string, opts: { force?: boolean; requestedBy?: string } = {},
): Promise<{ status: string; changed: boolean } | null> {
  let inputHash: string
  if (kind === 'bill') {
    const b = await db.select({ title: bills.title, textHash: bills.lastAiTextHash, isDraft: bills.isDraft }).from(bills).where(eq(bills.id, subjectId)).get()
    if (!b || b.isDraft) return null
    inputHash = await billHash(b, (await linkUrls(db, 'bill', [subjectId])).get(subjectId))
  } else {
    const e = await db.select({ id: calendarEvents.id, eventHash: calendarEvents.eventHash, date: calendarEvents.date, description: calendarEvents.description, source: calendarEvents.source })
      .from(calendarEvents).where(eq(calendarEvents.id, subjectId)).get()
    if (!e || e.source !== 'council') return null
    inputHash = await hearingHash(db, e)
  }
  const row = (await rowsFor(db, kind, [subjectId]))[0]
  const w = planRequest(db, kind, subjectId, inputHash, row, opts)
  if (!w) return { status: row!.status, changed: false }
  await w
  return { status: 'pending', changed: true }
}

/** Open requests, hearing briefs first (they have deadlines), then oldest first. */
export async function listOpenRequests(db: AppDb, limit = 20) {
  return db.select({ id: deepAnalyses.id, kind: deepAnalyses.kind, subjectId: deepAnalyses.subjectId, requestedAt: deepAnalyses.requestedAt, inputHash: deepAnalyses.inputHash })
    .from(deepAnalyses)
    .where(openRequest)
    .orderBy(sql`${deepAnalyses.kind} = 'bill'`, deepAnalyses.requestedAt)
    .limit(limit)
    .all()
}

async function teamContext(db: AppDb): Promise<string> {
  const [ctxRow, nameRow] = await Promise.all([
    db.select().from(associationConfig).where(eq(associationConfig.key, 'ai_context')).get(),
    db.select().from(associationConfig).where(eq(associationConfig.key, 'association_name')).get(),
  ])
  const stored = readConfigString(ctxRow)
  return isAiConfigDefault(stored) ? buildDefaultAiContext(readConfigString(nameRow) ?? ASSOCIATION_NAME_PLACEHOLDER) : stored!
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) as T } catch { return fallback }
}

/** A bill's text from central, for the worker's text download. */
export async function fetchBillText(env: Env, externalId: string): Promise<{ type: 'html' | 'pdf'; content: string } | 'missing' | 'unavailable'> {
  try {
    const res = await centralFetch(env, `/bills/${externalId}/text`)
    if (res.status === 404) return 'missing'
    if (!res.ok) return 'unavailable'
    return await res.json() as { type: 'html' | 'pdf'; content: string }
  } catch (err) {
    console.error('[deep] bill text fetch failed', err)
    return 'unavailable'
  }
}

type CentralVote = { id: string; motionText: string; date: string; result: string; chamber: string; memberVotes?: { name: string; vote: string }[] }

/** How many tracked bills the voting record draws on, highest relevance first. */
const VOTING_RECORD_BILLS = 40

function numericId(externalId: string | null): number | null {
  const m = /^legiscan:(\d+)$/.exec(externalId ?? '')
  return m ? Number(m[1]) : null
}

/** Recorded votes (with each member's vote) for these bills, keyed by external id. */
async function votesFor(env: Env, externalIds: string[]): Promise<Map<string, CentralVote[]>> {
  const out = new Map<string, CentralVote[]>()
  const ids = externalIds.map(numericId).filter((n): n is number => n !== null)
  if (ids.length === 0) return out
  try {
    const res = await centralFetch(env, '/bills/rich-batch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, memberVotes: true }),
    })
    if (!res.ok) return out
    const data = await res.json() as { byId: Record<string, { votes: CentralVote[] }> }
    for (const [id, v] of Object.entries(data.byId ?? {})) if (v.votes?.length) out.set(`legiscan:${id}`, v.votes)
  } catch (err) {
    console.error('[deep] vote lookup failed', err)
  }
  return out
}

const compactVotes = (votes: CentralVote[] | undefined) => (votes ?? []).map(v => ({
  date: v.date, motion: v.motionText, result: v.result, ...(v.memberVotes?.length ? { memberVotes: v.memberVotes } : {}),
}))

/**
 * How Councilmembers have voted on the team's tracked bills: every recorded
 * vote on the most relevant tracked bills (prioritized, hand-picked, or scored
 * 7 and up), so a brief can say where each member has stood on the issue.
 */
async function votingRecord(env: Env, db: AppDb, excludeId?: string) {
  const rows = await db.select({ id: bills.id, externalId: bills.externalId, number: bills.billNumber, title: bills.title, tags: bills.tags, relevance: bills.relevanceScore })
    .from(bills)
    .where(and(eq(bills.isDraft, false), isNotNull(bills.matchType), or(isNotNull(bills.priority), eq(bills.matchType, 'manual'), gte(bills.relevanceScore, 7))))
    .orderBy(sql`${bills.priority} IS NULL`, sql`${bills.relevanceScore} DESC`)
    .limit(VOTING_RECORD_BILLS * 2)
    .all()
  const candidates = rows.filter(r => r.id !== excludeId && numericId(r.externalId) !== null)
  const votes = await votesFor(env, candidates.map(r => r.externalId!))
  return candidates.filter(r => votes.has(r.externalId!)).slice(0, VOTING_RECORD_BILLS).map(r => ({
    number: r.number, title: r.title, tags: parseJson<string[]>(r.tags, []), votes: compactVotes(votes.get(r.externalId!)),
  }))
}

/**
 * The Council today: its committees (chair, members, key staff by name and
 * title, since contacts are shown to the team directly) and this Council
 * Period's members with their terms, marked current or former. A voting
 * record can name someone who has since left, and the brief must say so. A
 * note says where the Council's page and LIMS disagree, as for a member
 * re-elected after LIMS ended the term.
 */
async function councilRoster(env: Env): Promise<{ committees: unknown[]; councilmembers: unknown[] }> {
  try {
    const res = await centralFetch(env, '/bills/council-directory')
    if (!res.ok) return { committees: [], councilmembers: [] }
    const d = await res.json() as {
      committees: { name: string; chair: { name: string } | null; members: { name: string }[]; staff: { name: string; title: string | null }[]; agencies: string[] }[]
      councilmembers?: { name: string; role: string | null; termStart: string | null; termEnd: string | null; current: boolean; note?: string | null }[]
    }
    return {
      committees: d.committees.map(c => ({
        name: c.name, chair: c.chair?.name ?? null, members: c.members.map(m => m.name),
        staff: c.staff.map(s => s.title ? `${s.name}, ${s.title}` : s.name), agencies: c.agencies,
      })),
      councilmembers: (d.councilmembers ?? []).map(m => ({ name: m.name, role: m.role, termStart: m.termStart, termEnd: m.termEnd, status: m.current ? 'current' : 'former', ...(m.note ? { note: m.note } : {}) })),
    }
  } catch (err) {
    console.error('[deep] council roster lookup failed', err)
    return { committees: [], councilmembers: [] }
  }
}

async function teamDocuments(db: AppDb, kind: 'bill' | 'event', id: string) {
  return db.select({ title: teamLinks.title, url: teamLinks.url }).from(teamLinks)
    .where(and(eq(teamLinks.subjectKind, kind), eq(teamLinks.subjectId, id))).orderBy(teamLinks.addedAt).all()
}

/**
 * Everything a worker needs for one request except the bill text itself,
 * which it downloads from the request's text URL (a PDF can be large): the
 * instructions, the subject, the team's linked documents, the Council's
 * committee rosters, and the recorded votes.
 */
export async function buildDeepInput(env: Env, db: AppDb, row: { id: string; kind: DeepKind; subjectId: string; inputHash: string }) {
  const context = await teamContext(db)
  const [{ committees, councilmembers }, record] = await Promise.all([councilRoster(env), votingRecord(env, db, row.kind === 'bill' ? row.subjectId : undefined)])
  if (row.kind === 'bill') {
    const b = await db.select().from(bills).where(eq(bills.id, row.subjectId)).get()
    if (!b || b.isDraft) return null
    const own = b.externalId ? (await votesFor(env, [b.externalId])).get(b.externalId) : undefined
    return {
      id: row.id, kind: row.kind, inputHash: row.inputHash, promptVersion: DEEP_PROMPT_VERSION,
      instructions: billInstructions(context),
      bill: {
        number: b.billNumber, title: b.title, state: b.state, status: b.status, session: b.session,
        priority: b.priority, url: b.stateUrl ?? b.url, summary: b.tenantSummary,
        tags: parseJson<string[]>(b.tags, []), relevanceScore: b.relevanceScore,
        history: parseJson<unknown[]>(b.history, []),
        votes: compactVotes(own),
      },
      text: b.externalId ? { available: true, path: `/api/deep/worker/requests/${row.id}/text` } : { available: false },
      teamDocuments: await teamDocuments(db, 'bill', b.id),
      committees,
      councilmembers,
      votingRecord: record,
    }
  }
  const e = await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, row.subjectId), eq(calendarEvents.source, 'council'))).get()
  if (!e) return null
  const ids = (await linkedBills(db, e.id)).map(x => x.id)
  const linked = ids.length === 0 ? [] : await db.select().from(bills).where(and(inArray(bills.id, ids), eq(bills.isDraft, false))).all()
  const analyses = ids.length === 0 ? [] : await db.select({ subjectId: deepAnalyses.subjectId, content: deepAnalyses.content })
    .from(deepAnalyses).where(and(eq(deepAnalyses.kind, 'bill'), inArray(deepAnalyses.subjectId, ids), ne(deepAnalyses.status, 'error'))).all()
  const analysisBy = new Map(analyses.map(a => [a.subjectId, parseJson<unknown>(a.content, null)]))
  const linkedVotes = await votesFor(env, linked.map(b => b.externalId).filter((x): x is string => !!x))
  return {
    id: row.id, kind: row.kind, inputHash: row.inputHash, promptVersion: DEEP_PROMPT_VERSION,
    instructions: hearingInstructions(context),
    event: {
      title: e.description, date: e.date, time: e.time, timezone: e.timezone, location: e.location,
      details: e.details, url: e.url,
    },
    bills: linked.map(b => ({
      number: b.billNumber, title: b.title, status: b.status, priority: b.priority, summary: b.tenantSummary,
      deepAnalysis: analysisBy.get(b.id) ?? null,
      votes: compactVotes(b.externalId ? linkedVotes.get(b.externalId) : undefined),
    })),
    teamDocuments: await teamDocuments(db, 'event', e.id),
    committees,
    councilmembers,
    votingRecord: record,
  }
}

const LAST_FIRE_KEY = 'deep_worker_last_fire'
/** The hourly sweep starts the worker at most this often. */
const FIRE_MIN_INTERVAL_MINUTES = 55
/** A hand request starts it sooner, but not more than this often. */
const FIRE_MANUAL_INTERVAL_MINUTES = 10

/**
 * Start the operator's worker when requests are waiting, by POSTing to
 * DEEP_WORKER_FIRE_URL. Rate-limited so a subscription-backed worker (such as
 * a Claude Code routine, which has a daily run cap) runs only when there is
 * work. A Claude Code routine's /fire URL gets the headers that API needs.
 * Returns true when it fired.
 */
export async function fireDeepWorker(env: Env, db: AppDb, opts: { manual?: boolean } = {}): Promise<boolean> {
  if (!deepEnabled(env) || !env.DEEP_WORKER_FIRE_URL || !env.DEEP_WORKER_FIRE_TOKEN) return false
  const open = await listOpenRequests(db, 50)
  if (open.length === 0) return false
  const minutes = opts.manual ? FIRE_MANUAL_INTERVAL_MINUTES : FIRE_MIN_INTERVAL_MINUTES
  const last = await db.select().from(associationConfig).where(eq(associationConfig.key, LAST_FIRE_KEY)).get()
  if (last && Date.parse(last.value) > Date.now() - minutes * 60_000) return false
  const url = env.DEEP_WORKER_FIRE_URL
  const headers: Record<string, string> = { Authorization: `Bearer ${env.DEEP_WORKER_FIRE_TOKEN}`, 'Content-Type': 'application/json' }
  if (/\/v1\/claude_code\/routines\/[^/]+\/fire$/.test(new URL(url).pathname)) {
    headers['anthropic-beta'] = 'experimental-cc-routine-2026-04-01'
    headers['anthropic-version'] = '2023-06-01'
  }
  const now = new Date().toISOString()
  // Record the attempt first, so a failing endpoint is retried on the next interval, not every call.
  await db.insert(associationConfig).values({ key: LAST_FIRE_KEY, value: now })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: now } })
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ text: `FloorVote has ${open.length} deep-analysis request${open.length === 1 ? '' : 's'} waiting.` }) })
  if (!res.ok) {
    console.error(`[deep] worker fire returned ${res.status}`)
    return false
  }
  return true
}
