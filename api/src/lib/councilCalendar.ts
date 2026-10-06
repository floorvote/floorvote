import { and, eq, gte, inArray, isNotNull, like, lte } from 'drizzle-orm'
import { associationConfig, bills, calendarEventBills, calendarEvents } from '../db/schema'
import { centralFetch } from './centralFetch'
import { matchesUnion } from './keywords'
import type { AppDb, Env } from '../types'
import type { CouncilCalendarRulesShape } from '../../../shared/councilCalendarPresets'

/**
 * Council calendar rules: which DC Council hearings and meetings belong on this
 * team's calendar. Stored as JSON in association_config under
 * `council_calendar_rules`; absent means the team takes no Council events.
 *
 * Council events are a calendar source of their own ('council'). Unlike bill
 * hearings they are not gated on a bill's priority: most of what a DC team
 * prepares for (performance and budget oversight hearings, roundtables,
 * legislative and breakfast meetings) has no bill to prioritize.
 */
export interface CouncilCalendarRules extends CouncilCalendarRulesShape {
  /** Match an event by committee (the event title) or its joint committees; `type` narrows it. */
  include?: { committee: string; type?: string }[]
  /** Match every event of these hearing types, whichever committee holds it. */
  types?: string[]
  /** FloorVote keyword syntax, matched against each agenda topic. */
  topicKeywords?: string[]
  /** Include any event whose agenda lists a bill this team tracks (keyword, manual, or prioritized). */
  trackedBills?: boolean
}

export const COUNCIL_RULES_KEY = 'council_calendar_rules'

const MAX_RULE_ITEMS = 200
const MAX_RULE_TEXT = 200

/** Validate rules posted from Settings. Returns the cleaned rules or an error message. */
export function parseCouncilRules(input: unknown): CouncilCalendarRules | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'rules must be an object'
  const r = input as Record<string, unknown>
  const text = (v: unknown): string | null => typeof v === 'string' && v.trim() && v.trim().length <= MAX_RULE_TEXT ? v.trim() : null
  const list = (v: unknown, name: string): string[] | string => {
    if (v === undefined) return []
    if (!Array.isArray(v) || v.length > MAX_RULE_ITEMS) return `${name} must be a list of at most ${MAX_RULE_ITEMS}`
    const out: string[] = []
    for (const x of v) {
      const t = text(x)
      if (!t) return `${name} entries must be non-empty text of at most ${MAX_RULE_TEXT} characters`
      if (!out.includes(t)) out.push(t)
    }
    return out
  }
  const include: { committee: string; type?: string }[] = []
  if (r.include !== undefined) {
    if (!Array.isArray(r.include) || r.include.length > MAX_RULE_ITEMS) return `include must be a list of at most ${MAX_RULE_ITEMS}`
    for (const x of r.include) {
      const o = (x ?? {}) as Record<string, unknown>
      const committee = text(o.committee)
      if (!committee) return 'each include entry needs a committee'
      const type = o.type === undefined || o.type === null || o.type === '' ? undefined : text(o.type)
      if (type === null) return 'include type must be text'
      include.push(type ? { committee, type } : { committee })
    }
  }
  const types = list(r.types, 'types')
  if (typeof types === 'string') return types
  const topicKeywords = list(r.topicKeywords, 'topicKeywords')
  if (typeof topicKeywords === 'string') return topicKeywords
  if (r.trackedBills !== undefined && typeof r.trackedBills !== 'boolean') return 'trackedBills must be true or false'
  return { include, types, topicKeywords, trackedBills: r.trackedBills === true }
}

export interface CouncilEvent {
  hearingId: number
  date: string
  time: string | null
  hearingType: string
  title: string
  jointWith: string | null
  location: string | null
  topics: { topic: string; number: string | null }[]
  witnessList: { attachmentGuid: string; attachmentName: string } | null
  url: string
  eventHash: string
  removedAt: string | null
}

const WINDOW_BACK_DAYS = 14
const WINDOW_AHEAD_DAYS = 150

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

export function councilEventMatches(e: CouncilEvent, rules: CouncilCalendarRules, tracked: Set<string>): boolean {
  const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  for (const r of rules.include ?? []) {
    const c = norm(r.committee)
    const committeeHit = norm(e.title) === c || norm(e.jointWith).includes(c)
    if (committeeHit && (!r.type || norm(r.type) === norm(e.hearingType))) return true
  }
  if ((rules.types ?? []).some(t => norm(t) === norm(e.hearingType))) return true
  const kws = (rules.topicKeywords ?? []).map(k => k.toLowerCase())
  if (kws.length > 0 && e.topics.some(t => matchesUnion(t.topic, kws).matched)) return true
  if (rules.trackedBills && e.topics.some(t => t.number && tracked.has(t.number))) return true
  return false
}

/** "Youth Affairs roundtable: DYRS' Fifth Rulemaking ..." — committee, type, and the agenda. */
export function councilEventTitle(e: CouncilEvent): string {
  const topics = e.topics.map(t => t.topic).filter(Boolean)
  const kind = e.hearingType.toLowerCase()
  const lead = e.title === 'Legislative Meeting' ? e.title : `${e.title} ${kind}`
  const agenda = topics.length === 0 ? '' : topics.length <= 2 ? `: ${topics.join('; ')}` : `: ${topics[0]}; and ${topics.length - 1} more`
  return `${lead}${agenda}`
}

function councilEventDetails(e: CouncilEvent): string {
  const lines = e.topics.map(t => `- ${t.topic}${t.number ? ` (${t.number})` : ''}`)
  if (e.jointWith) lines.unshift(e.jointWith)
  lines.push('', `Details, witness list, and testimony sign-up: ${e.url}`)
  return lines.join('\n')
}

/**
 * The Council calendar window from central (two weeks back, five months ahead),
 * with the agenda's bill numbers resolved to this team's bills.
 */
export async function loadCouncilWindow(env: Env, db: AppDb) {
  const from = isoDay(-WINDOW_BACK_DAYS)
  const to = isoDay(WINDOW_AHEAD_DAYS)
  const res = await centralFetch(env, `/bills/council-events?from=${from}&to=${to}`)
  if (!res.ok) throw new Error(`central council-events HTTP ${res.status}`)
  const events = await res.json() as CouncilEvent[]

  // Bill numbers this team tracks, and a number → tenant bill id map for linking.
  const numbers = [...new Set(events.flatMap(e => e.topics.map(t => t.number).filter((n): n is string => !!n)))]
  const byNumber = new Map<string, { id: string; tracked: boolean }>()
  for (let i = 0; i < numbers.length; i += 80) {
    const chunk = numbers.slice(i, i + 80)
    const rows = await db.select({ id: bills.id, billNumber: bills.billNumber, matchType: bills.matchType, priority: bills.priority })
      .from(bills).where(and(inArray(bills.billNumber, chunk), eq(bills.state, 'DC'))).all()
    for (const r of rows) byNumber.set(r.billNumber, { id: r.id, tracked: !!r.matchType || !!r.priority })
  }
  const tracked = new Set([...byNumber].filter(([, v]) => v.tracked).map(([k]) => k))

  // Hearing notices and the day each is scheduled for. An oversight roundtable's
  // topic carries no measure number, so it links to its notice by day and topic.
  const notices = await db.select({ id: bills.id, title: bills.title, date: calendarEvents.date })
    .from(calendarEvents).innerJoin(bills, eq(bills.id, calendarEvents.billId))
    .where(and(eq(calendarEvents.source, 'hearing'), gte(calendarEvents.date, from), lte(calendarEvents.date, to),
      eq(bills.state, 'DC'), like(bills.billNumber, 'HN%'))).all()
  return { from, to, events, byNumber, tracked, notices }
}

function topicKey(s: string): string {
  return s.toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * The hearing notice a numberless topic belongs to: the one notice set for the
 * same day whose title names the topic ("Committee on Youth Affairs 10/7
 * Roundtable on DYRS' Fifth Rulemaking on ..."). None when zero or several match.
 */
export function hearingNoticeFor(topic: string, date: string, notices: { id: string; title: string | null; date: string | null }[]): string | null {
  const k = topicKey(topic)
  if (k.length < 12) return null
  const hits = notices.filter(n => n.date === date && topicKey(n.title ?? '').includes(k))
  return hits.length === 1 ? hits[0].id : null
}

/** The tenant bills a Council event covers: numbered topics, and numberless ones by their hearing notice. */
function eventBillIds(e: CouncilEvent, byNumber: Map<string, { id: string }>, notices: { id: string; title: string | null; date: string | null }[]): string[] {
  const ids = e.topics.map(t => t.number ? byNumber.get(t.number)?.id ?? null : hearingNoticeFor(t.topic, e.date, notices))
  return [...new Set(ids.filter((id): id is string => !!id))]
}

/** Point an event's bill links at `billIds`, writing only when they differ. */
async function relinkEvent(db: AppDb, eventId: string, billIds: string[]): Promise<void> {
  const current = (await db.select({ billId: calendarEventBills.billId }).from(calendarEventBills)
    .where(eq(calendarEventBills.eventId, eventId)).all()).map(r => r.billId).sort()
  const want = [...billIds].sort()
  if (current.length === want.length && current.every((id, i) => id === want[i])) return
  await db.delete(calendarEventBills).where(eq(calendarEventBills.eventId, eventId))
  for (const billId of want) await db.insert(calendarEventBills).values({ eventId, billId }).onConflictDoNothing()
}

/**
 * Upcoming events (today onward) a set of rules would select, for the Settings
 * preview. Nothing is written.
 */
export async function previewCouncilRules(env: Env, db: AppDb, rules: CouncilCalendarRules): Promise<{ date: string; time: string | null; title: string; url: string }[]> {
  const { events, tracked } = await loadCouncilWindow(env, db)
  const today = isoDay(0)
  return events
    .filter(e => !e.removedAt && e.date >= today && councilEventMatches(e, rules, tracked))
    .sort((a, b) => `${a.date}${a.time ?? ''}`.localeCompare(`${b.date}${b.time ?? ''}`))
    .map(e => ({ date: e.date, time: e.time, title: councilEventTitle(e), url: e.url }))
}

/**
 * Pull the Council calendar window from central, keep the events this team's
 * rules select, and mirror them into calendar_events (source 'council'). Events
 * the Council removed are cancelled; events the rules no longer select are
 * deleted. Runs on the tenant's hourly cron.
 */
export async function syncCouncilCalendarEvents(env: Env, db: AppDb): Promise<{ upserted: number; cancelled: number; deleted: number } | null> {
  const rulesRow = await db.select().from(associationConfig).where(eq(associationConfig.key, COUNCIL_RULES_KEY)).get()
  if (!rulesRow) return null
  let rules: CouncilCalendarRules
  try { rules = JSON.parse(rulesRow.value) as CouncilCalendarRules } catch { return null }

  const { from, to, events, byNumber, tracked, notices } = await loadCouncilWindow(env, db)

  const existing = new Map((await db.select({ id: calendarEvents.id, uid: calendarEvents.uid, eventHash: calendarEvents.eventHash, sequence: calendarEvents.sequence, status: calendarEvents.status })
    .from(calendarEvents)
    .where(and(eq(calendarEvents.source, 'council'), isNotNull(calendarEvents.date), gte(calendarEvents.date, from), lte(calendarEvents.date, to)))
    .all()).map(r => [r.uid, r]))

  let upserted = 0, cancelled = 0, deleted = 0
  const keep = new Set<string>()
  for (const e of events) {
    if (!councilEventMatches(e, rules, tracked)) continue
    const uid = `council-${e.hearingId}@lims.dccouncil.gov`
    keep.add(uid)
    const prior = existing.get(uid)
    const status = e.removedAt ? 'cancelled' as const : 'confirmed' as const
    if (prior && prior.eventHash === e.eventHash && prior.status === status) {
      // A notice can arrive after its event, so links are checked every run.
      await relinkEvent(db, prior.id, eventBillIds(e, byNumber, notices))
      continue
    }
    const values = {
      date: e.date,
      time: e.time,
      location: e.location,
      description: councilEventTitle(e),
      details: councilEventDetails(e),
      url: e.url,
      status,
      eventHash: e.eventHash,
      timezone: 'America/New_York',
      updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }
    let eventId: string
    if (prior) {
      eventId = prior.id
      await db.update(calendarEvents).set({ ...values, sequence: prior.sequence + 1 }).where(eq(calendarEvents.id, prior.id))
    } else {
      eventId = crypto.randomUUID()
      await db.insert(calendarEvents).values({ id: eventId, uid, source: 'council', sequence: 0, billId: null, ...values })
    }
    if (status === 'cancelled') cancelled++
    else upserted++
    await relinkEvent(db, eventId, eventBillIds(e, byNumber, notices))
  }
  // Rules no longer select these (or the Council window moved past them without a removal).
  for (const [uid, row] of existing) {
    if (keep.has(uid)) continue
    await db.delete(calendarEventBills).where(eq(calendarEventBills.eventId, row.id))
    await db.delete(calendarEvents).where(eq(calendarEvents.id, row.id))
    deleted++
  }
  return { upserted, cancelled, deleted }
}
