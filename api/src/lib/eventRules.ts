import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { associationConfig, bills, calendarEventBills, calendarEvents } from '../db/schema'
import {
  eventMatchesRules, parseEventRules, rulesFromCouncilCalendar, type AgendaBills, type EventFacets, type EventRules,
} from '../../../shared/eventRules'
import { centralFetch } from './centralFetch'
import { groupHasPriority } from './teamFields'
import type { AppDb, Env } from '../types'
import type { CentralBodyEvent } from './bodyEvents'

/**
 * Event rules (#298, shared/eventRules.ts): which body events the instance
 * shows. Stored as JSON in association_config under `event_rules`. With none,
 * every body event of the covered states shows.
 *
 * Each body event keeps what the rules read of it (calendar_events.rule_facets,
 * written by the hourly sync in lib/bodyEvents.ts) and whether the rules
 * select it (rule_match: null with no rules, else 1 or 0). The calendar, ICS
 * feed, and dashboard count hide an event whose rule_match is 0
 * (lib/calendarVisibility.ts), and the week-ahead email takes one whose
 * rule_match is 1. Saving or clearing rules rewrites rule_match locally, in
 * the same batch as the rules themselves, so nothing waits on central and no
 * event is left selected by rules that are gone. The hourly sync applies the
 * rules again, so events new since, and bills tracked or prioritized since,
 * are selected within the hour. Rules never hide an event with a prioritized
 * bill on its agenda, so the calendar and the week-ahead email agree.
 *
 * A fork's teams set their DC Council calendar rules in #217's
 * `council_calendar_rules`. While an instance has no `event_rules`, those are
 * carried over (rulesFromCouncilCalendar) and saved as its event rules once
 * central's committee list arrives. Until it does, nothing is applied, and
 * the next hourly sync tries again.
 */

export const EVENT_RULES_KEY = 'event_rules'
/** #217's DC Council calendar rules, on a fork's instances. */
export const COUNCIL_RULES_KEY = 'council_calendar_rules'

/** What the rules read of an event central sent. */
export function bodyEventFacets(e: CentralBodyEvent): EventFacets {
  return {
    committeeId: e.committee?.committeeId ?? null,
    committee: e.committee?.name ?? null,
    jointWith: e.jointWith,
    kind: e.kind,
    type: e.type,
    title: e.title,
    topics: e.agenda.map(a => a.topic.trim()).filter(Boolean),
  }
}

function parseFacets(json: string | null): EventFacets | null {
  if (!json) return null
  try {
    const f = JSON.parse(json) as EventFacets
    return f && typeof f.kind === 'string' && typeof f.title === 'string' && Array.isArray(f.topics) ? f : null
  } catch {
    return null
  }
}

/** The committees the instance's body events name, for carrying a fork's rules over. */
async function heldCommittees(db: AppDb): Promise<{ committeeId: string; name: string }[]> {
  const out = new Map<string, string>()
  for (const r of await db.select({ ruleFacets: calendarEvents.ruleFacets }).from(calendarEvents)
    .where(and(eq(calendarEvents.source, 'body'), isNotNull(calendarEvents.ruleFacets))).all()) {
    const f = parseFacets(r.ruleFacets)
    if (f?.committeeId && f.committee) out.set(f.committeeId, f.committee)
  }
  return [...out].map(([committeeId, name]) => ({ committeeId, name }))
}

type CommitteeList = readonly { committeeId: string; name: string }[]

/** A stored JSON value, or null when it doesn't parse. */
function storedJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return null }
}

/** Stored event rules, or null (every event shows) when they no longer parse. */
function storedRules(value: string): EventRules | null {
  const rules = parseEventRules(storedJson(value))
  if (typeof rules !== 'string') return rules
  console.error(`[event-rules] stored rules are invalid, showing every event: ${rules}`)
  return null
}

/** The instance's event rules, and whether they are settled. */
export interface LoadedEventRules {
  /** The rules, or null when the instance has none and every event shows. */
  rules: EventRules | null
  /**
   * False while a fork's #217 rules are carried over without committees to
   * match their names to (central didn't answer, or neither it nor the
   * instance's events name any). `rules` is then a provisional carry-over,
   * not saved, and nothing should be applied until it settles.
   */
  settled: boolean
  /** True when this call saved a fork's carried-over rules. */
  carriedOver?: boolean
}

/**
 * The instance's event rules. A fork's #217 rules are carried over and saved
 * the first time central's committee list arrives (`committees`, asked for
 * only then, null when central didn't answer) and it or the instance's events
 * name some committee, so committee names become committees rather than
 * keywords. Until then they're unsettled, and the hourly sync applies nothing
 * and tries again. Stored rules that no longer parse count as none, so every
 * event shows.
 */
export async function loadEventRules(db: AppDb, committees: CommitteeList | null | (() => Promise<CommitteeList | null>)): Promise<LoadedEventRules> {
  const rows = await db.select().from(associationConfig)
    .where(inArray(associationConfig.key, [EVENT_RULES_KEY, COUNCIL_RULES_KEY])).all()
  const saved = rows.find(r => r.key === EVENT_RULES_KEY)
  if (saved) return { rules: storedRules(saved.value), settled: true }

  const legacyRow = rows.find(r => r.key === COUNCIL_RULES_KEY)
  if (!legacyRow) return { rules: null, settled: true }
  const legacy = storedJson(legacyRow.value)
  const listed = typeof committees === 'function' ? await committees() : committees
  const held = await heldCommittees(db)
  const carried = rulesFromCouncilCalendar(legacy, [...(listed ?? []), ...held])
  if (!carried) return { rules: null, settled: true }
  // With no committee to match against, every committee name the fork chose would become a keyword for good.
  const namesCommittees = Array.isArray((legacy as { include?: unknown }).include) && (legacy as { include: unknown[] }).include.length > 0
  if (!listed || (namesCommittees && listed.length + held.length === 0)) return { rules: carried, settled: false }
  // Saved once, so the Calendar page's control shows them and edits them from here on.
  await db.insert(associationConfig).values({ key: EVENT_RULES_KEY, value: JSON.stringify(carried) }).onConflictDoNothing()
  // An admin may have saved rules meanwhile: theirs win, and are what applies.
  const stored = await db.select().from(associationConfig).where(eq(associationConfig.key, EVENT_RULES_KEY)).get()
  if (!stored) return { rules: carried, settled: true, carriedOver: true }
  return { rules: storedRules(stored.value), settled: true, carriedOver: stored.value === JSON.stringify(carried) }
}

/** The committees and kinds central lists for a state (GET /tenants/:tenantId/body-event-options). */
export interface StateOptions {
  committees: { committeeId: string; name: string; chamber: string | null }[]
  kinds: { kind: string; types: string[] }[]
}

/** What central lists for each covered state with body events, or null when central didn't answer. */
export async function centralOptions(env: Env): Promise<Record<string, StateOptions> | null> {
  try {
    const res = await centralFetch(env, `/tenants/${env.TENANT_ID}/body-event-options`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json() as { states?: unknown }
    if (!body.states || typeof body.states !== 'object' || Array.isArray(body.states)) throw new Error('the answer has no states')
    const states = body.states as Record<string, Partial<StateOptions>>
    return Object.fromEntries(Object.entries(states).map(([state, o]) => [state, { committees: o.committees ?? [], kinds: o.kinds ?? [] }]))
  } catch (err) {
    console.error('[event-rules] central options unavailable', err)
    return null
  }
}

/** Central's committees for the covered states, each with its state, or null when central didn't answer. */
export function optionCommittees(states: Record<string, StateOptions> | null) {
  return states && Object.entries(states).flatMap(([state, o]) => o.committees.map(c => ({ ...c, state })))
}

function chunks<T>(items: readonly T[], size = 80): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface RuleCounts {
  /** Body events the rules select (or every one, with no rules). */
  shown: number
  hidden: number
}

const NO_AGENDA_BILLS: AgendaBills = { tracked: false, prioritized: false }

/**
 * Whether each body event has a bill the instance tracks, and one whose group
 * has a priority (the bill's own, or a companion's: `groupHasPriority`), on its agenda, by event id (`ids` limits it to those events).
 */
export async function agendaBills(db: AppDb, ids?: readonly string[]): Promise<Map<string, AgendaBills>> {
  const out = new Map<string, AgendaBills>()
  const read = async (only?: readonly string[]) => {
    for (const r of await db.select({ eventId: calendarEventBills.eventId, matchType: bills.matchType, prioritized: sql<number>`${groupHasPriority(bills)}` })
      .from(calendarEventBills)
      .innerJoin(calendarEvents, eq(calendarEvents.id, calendarEventBills.eventId))
      .innerJoin(bills, eq(bills.id, calendarEventBills.billId))
      .where(and(eq(calendarEvents.source, 'body'), or(isNotNull(bills.matchType), groupHasPriority(bills)),
        only ? inArray(calendarEventBills.eventId, [...only]) : undefined)).all()) {
      const prior = out.get(r.eventId) ?? NO_AGENDA_BILLS
      out.set(r.eventId, { tracked: true, prioritized: prior.prioritized || r.prioritized === 1 })
    }
  }
  if (!ids) await read()
  else for (const chunk of chunks(ids)) await read(chunk)
  return out
}

/**
 * The statements that set each body event's rule_match under `rules`, and
 * what they leave shown and hidden. Writes only rows whose value changes. An
 * event the sync hasn't described yet (no rule_facets) stays null, and shows,
 * until the next sync describes it.
 */
async function ruleMatchStatements(db: AppDb, rules: EventRules | null) {
  const rows = await db.select({ id: calendarEvents.id, ruleFacets: calendarEvents.ruleFacets, ruleMatch: calendarEvents.ruleMatch })
    .from(calendarEvents).where(eq(calendarEvents.source, 'body')).all()

  const want = new Map<string, number | null>()
  if (rules) {
    const agenda = await agendaBills(db)
    for (const r of rows) {
      const facets = parseFacets(r.ruleFacets)
      want.set(r.id, facets ? (eventMatchesRules(facets, rules, agenda.get(r.id) ?? NO_AGENDA_BILLS) ? 1 : 0) : null)
    }
  } else {
    for (const r of rows) want.set(r.id, null)
  }

  const byValue = new Map<number | null, string[]>()
  const counts: RuleCounts = { shown: 0, hidden: 0 }
  for (const r of rows) {
    const next = want.get(r.id) ?? null
    if (next === 0) counts.hidden++
    else counts.shown++
    if (next === r.ruleMatch) continue
    byValue.set(next, [...(byValue.get(next) ?? []), r.id])
  }
  const statements = [...byValue].flatMap(([value, ids]) => chunks(ids).map(chunk =>
    db.update(calendarEvents).set({ ruleMatch: value }).where(inArray(calendarEvents.id, chunk))))
  return { statements, counts }
}

/** Apply `rules` to every body event the instance holds. */
export async function applyEventRules(db: AppDb, rules: EventRules | null): Promise<RuleCounts> {
  const { statements, counts } = await ruleMatchStatements(db, rules)
  for (const chunk of chunks(statements, 50)) await db.batch(chunk as [typeof chunk[number], ...typeof chunk])
  return counts
}

/**
 * Save the instance's event rules, or clear them with null, and apply them to
 * every body event in the same batch: the rules and what they select change
 * together or not at all. Clearing also drops a fork's #217 rules, so they
 * aren't carried over again.
 */
export async function saveEventRules(db: AppDb, rules: EventRules | null): Promise<RuleCounts> {
  const { statements, counts } = await ruleMatchStatements(db, rules)
  const config = rules
    ? db.insert(associationConfig).values({ key: EVENT_RULES_KEY, value: JSON.stringify(rules) })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify(rules) } })
    : db.delete(associationConfig).where(inArray(associationConfig.key, [EVENT_RULES_KEY, COUNCIL_RULES_KEY]))
  await db.batch([config, ...statements])
  return counts
}
