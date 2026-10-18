import { matchesUnion } from './keywords'

/**
 * Event rules (#298): which body events, the legislature's own calendar, an
 * instance shows. An instance with no rules shows every body event of its
 * covered states. Once an admin saves rules, an event shows when any rule
 * selects it:
 *
 * - a committee it is held by (or held jointly with), optionally narrowed to
 *   one kind or event type;
 * - a kind or event type, whichever committee holds it;
 * - a topic: a named list of keywords, in the bill keyword syntax, matched
 *   against the event's title and agenda;
 * - a bill the instance tracks on its agenda.
 *
 * Rules never hide an event with a prioritized bill on its agenda: that is
 * the bill's hearing, which the instance shows whatever the rules say, and
 * the week-ahead email lists.
 *
 * Committees, kinds, and event types are the ones central lists for the state
 * (GET /tenants/:tenantId/body-event-options), so rules never name one a
 * provider can't send. A kind is generic ('hearing', 'markup', 'meeting'), and
 * an event type is the provider's own name for it ("Budget Oversight Hearing"),
 * so a rule can be as broad or as narrow as the team wants. Topics are the
 * instance's own content: nothing in code presets them.
 *
 * The api applies the rules (api/src/lib/eventRules.ts) with `eventMatchesRules`.
 * Since #420 the Calendar page's control edits them, offering every event or
 * chosen committees only; the rest of this shape keeps matching for rules
 * saved before it.
 */
export interface EventRules {
  /** Committees, by central committee id, each with its name for display and joint hearings. */
  committees: EventRuleCommittee[]
  /** Kinds or event types, in any committee. A value matches an event's kind exactly, or its event type in any case. */
  kinds: string[]
  topics: EventRuleTopic[]
  /** Show any event with a bill the instance tracks (a keyword match, an added bill, or a prioritized one) on its agenda. */
  trackedBills: boolean
  /**
   * States whose every event shows, whatever committee holds it (#695). The
   * Calendar page's gear sets rules per state, so one state can show every
   * event while another shows chosen committees. Absent when no state is
   * shown in full: a committee is the only way an event of a state not listed
   * here is selected.
   */
  allStates?: string[]
}

export interface EventRuleCommittee {
  committeeId: string
  name: string
  /** Only this committee's events of this kind or event type. Every event when absent. */
  kind?: string
}

export interface EventRuleTopic {
  name: string
  keywords: string[]
}

/** The instance's bills on an event's agenda: one it tracks, and one with a priority. */
export interface AgendaBills {
  tracked: boolean
  prioritized: boolean
}

/** What the rules read of an event. The api keeps these with each body event. */
export interface EventFacets {
  committeeId: string | null
  committee: string | null
  jointWith: string | null
  /** The state whose legislature holds the event. Absent on an event described before states were kept. */
  state?: string | null
  kind: string
  type: string | null
  title: string
  topics: string[]
}

export const EMPTY_EVENT_RULES: EventRules = { committees: [], kinds: [], topics: [], trackedBills: false }

const MAX_ITEMS = 200
const MAX_TOPICS = 50
const MAX_TEXT = 200

/** Validate posted rules. Returns the cleaned rules or an error message. */
export function parseEventRules(input: unknown): EventRules | string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'rules must be an object'
  const r = input as Record<string, unknown>
  const text = (v: unknown): string | null => typeof v === 'string' && v.trim() && v.trim().length <= MAX_TEXT ? v.trim() : null
  const list = (v: unknown, name: string): string[] | string => {
    if (v === undefined) return []
    if (!Array.isArray(v) || v.length > MAX_ITEMS) return `${name} must be a list of at most ${MAX_ITEMS}`
    const out: string[] = []
    for (const x of v) {
      const t = text(x)
      if (!t) return `${name} entries must be non-empty text of at most ${MAX_TEXT} characters`
      if (!out.includes(t)) out.push(t)
    }
    return out
  }

  const committees: EventRuleCommittee[] = []
  if (r.committees !== undefined) {
    if (!Array.isArray(r.committees) || r.committees.length > MAX_ITEMS) return `committees must be a list of at most ${MAX_ITEMS}`
    for (const x of r.committees) {
      const o = (x ?? {}) as Record<string, unknown>
      const committeeId = text(o.committeeId)
      const name = text(o.name)
      if (!committeeId || !name) return 'each committee needs a committeeId and a name'
      const kind = o.kind === undefined || o.kind === null || o.kind === '' ? undefined : text(o.kind)
      if (kind === null) return 'a committee\'s kind must be text'
      if (committees.some(c => c.committeeId === committeeId)) return `committee ${committeeId} is listed twice`
      committees.push(kind ? { committeeId, name, kind } : { committeeId, name })
    }
  }
  const kinds = list(r.kinds, 'kinds')
  if (typeof kinds === 'string') return kinds

  const topics: EventRuleTopic[] = []
  if (r.topics !== undefined) {
    if (!Array.isArray(r.topics) || r.topics.length > MAX_TOPICS) return `topics must be a list of at most ${MAX_TOPICS}`
    for (const x of r.topics) {
      const o = (x ?? {}) as Record<string, unknown>
      const name = text(o.name)
      if (!name) return 'each topic needs a name'
      const keywords = list(o.keywords, `topic "${name}" keywords`)
      if (typeof keywords === 'string') return keywords
      if (keywords.length === 0) return `topic "${name}" needs at least one keyword`
      topics.push({ name, keywords })
    }
  }
  if (r.trackedBills !== undefined && typeof r.trackedBills !== 'boolean') return 'trackedBills must be true or false'
  const allStates = list(r.allStates, 'allStates')
  if (typeof allStates === 'string') return allStates
  if (allStates.some(code => !/^[A-Z]{2}$/.test(code))) return 'allStates entries must be two-letter uppercase state codes'
  return { committees, kinds, topics, trackedBills: r.trackedBills === true, ...(allStates.length > 0 ? { allStates } : {}) }
}

/** "Youth Affairs" for "Committee on Youth Affairs": how a legislature's calendar names it in joint hearings. */
function shortCommitteeName(name: string): string {
  return name.trim().replace(/^committee on\s+/i, '')
}

/**
 * Whether a rule's kind or event type names the event: its kind exactly, or
 * its event type without regard to case, as #217's hearing types matched. Any
 * value is compared with the type, so a kind-named value ('meeting') also
 * selects an event typed "Meeting" under another kind.
 */
function isKind(event: EventFacets, value: string): boolean {
  return value === event.kind || (event.type !== null && value.toLowerCase() === event.type.toLowerCase())
}

/**
 * Whether the instance shows an event under `rules`: a prioritized bill is on
 * its agenda, or a rule selects it.
 */
export function eventMatchesRules(event: EventFacets, rules: EventRules, agenda: AgendaBills): boolean {
  if (agenda.prioritized) return true
  if (event.state && rules.allStates?.includes(event.state)) return true
  for (const c of rules.committees) {
    const held = event.committeeId === c.committeeId
      || (!!event.jointWith && matchesUnion(event.jointWith, [shortCommitteeName(c.name)]).matched)
    if (held && (!c.kind || isKind(event, c.kind))) return true
  }
  if (rules.kinds.some(k => isKind(event, k))) return true
  if (rules.topics.length > 0) {
    const texts = [event.title, ...event.topics].filter(Boolean)
    if (rules.topics.some(t => texts.some(s => matchesUnion(s, t.keywords).matched))) return true
  }
  return rules.trackedBills && agenda.tracked
}

/** The topic a fork's DC Council calendar keywords become. */
export const COUNCIL_CALENDAR_TOPIC = 'From the DC Council calendar settings'

/**
 * A fork's DC Council calendar rules (#217's `council_calendar_rules`) as
 * event rules, so its teams keep the events they chose. Each committee name is
 * matched to a committee central lists, by its name or its short name
 * ("Health" for "Committee on Health"). A name that matches none (the
 * Council's "Legislative Meeting") becomes a keyword in the topic, which
 * matches the event's title. Hearing types become event types, since #217's
 * types are the Council's own names. Null for anything that isn't #217's
 * shape.
 */
export function rulesFromCouncilCalendar(legacy: unknown, committees: readonly { committeeId: string; name: string }[]): EventRules | null {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return null
  const l = legacy as { include?: unknown; types?: unknown; topicKeywords?: unknown; trackedBills?: unknown }
  const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : []
  const byName = new Map<string, { committeeId: string; name: string }>()
  for (const c of committees) {
    byName.set(c.name.trim().toLowerCase(), c)
    byName.set(shortCommitteeName(c.name).toLowerCase(), c)
  }

  const out: EventRules = { committees: [], kinds: strings(l.types), topics: [], trackedBills: l.trackedBills === true }
  const keywords = strings(l.topicKeywords)
  for (const entry of Array.isArray(l.include) ? l.include : []) {
    const name = typeof entry?.committee === 'string' ? entry.committee.trim() : ''
    if (!name) continue
    const kind = typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : undefined
    const committee = byName.get(name.toLowerCase())
    if (!committee) {
      if (!keywords.includes(name.toLowerCase())) keywords.push(name.toLowerCase())
      continue
    }
    const prior = out.committees.find(c => c.committeeId === committee.committeeId)
    // A committee listed twice keeps its broadest entry: every event wins, and
    // so do two kinds, since a rule narrows a committee to one kind at most
    // ("Health: Oversight Hearing" and "Health: Roundtable" keep both).
    if (prior) { if (!kind || kind !== prior.kind) delete prior.kind; continue }
    // Only the id and name: central's list carries more (chamber, state) that rules don't keep.
    const { committeeId, name: committeeName } = committee
    out.committees.push(kind ? { committeeId, name: committeeName, kind } : { committeeId, name: committeeName })
  }
  if (keywords.length > 0) out.topics.push({ name: COUNCIL_CALENDAR_TOPIC, keywords: [...new Set(keywords)] })
  return out
}

/**
 * What a saved rule keeps beyond the Calendar control's one choice (#420): the
 * control offers every event or chosen committees, so a rule saved earlier
 * with kinds, event types, topics, tracked bills, or a committee narrowed to
 * a kind keeps all of it. It matches exactly as before and shows in the
 * control as one line with Remove.
 */
export interface LegacyParts {
  kinds: string[]
  topics: string[]
  trackedBills: boolean
  narrowedCommittees: { name: string; kind: string }[]
}

export function legacyParts(rules: EventRules | null): LegacyParts {
  return {
    kinds: rules?.kinds ?? [],
    topics: (rules?.topics ?? []).map(t => t.name),
    trackedBills: rules?.trackedBills === true,
    narrowedCommittees: (rules?.committees ?? []).flatMap(c => c.kind ? [{ name: c.name, kind: c.kind }] : []),
  }
}

export function hasLegacyParts(parts: LegacyParts): boolean {
  return parts.kinds.length > 0 || parts.topics.length > 0 || parts.trackedBills || parts.narrowedCommittees.length > 0
}

/** "Kept from an earlier setting: ..." for the control's menu, or '' when nothing is kept. */
export function legacyNote(parts: LegacyParts): string {
  if (!hasLegacyParts(parts)) return ''
  const phrases = [
    ...parts.kinds.map(k => `every ${k} event`),
    ...parts.narrowedCommittees.map(c => `${c.name}, ${c.kind} events only`),
    ...parts.topics.map(t => `the topic "${t}"`),
    ...(parts.trackedBills ? ['events with a bill we track'] : []),
  ]
  const list = phrases.length <= 2 ? phrases.join(' and ') : `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`
  return `Kept from an earlier setting: ${list}.`
}

/** The rules with every legacy part removed: each committee's every event, and nothing else. */
export function withoutLegacyParts(rules: EventRules): EventRules {
  return {
    committees: rules.committees.map(({ committeeId, name }) => ({ committeeId, name })),
    kinds: [],
    topics: [],
    trackedBills: false,
    // A state shown in full is the gear's own choice (#695), not a part kept from before it.
    ...(rules.allStates?.length ? { allStates: rules.allStates } : {}),
  }
}

/**
 * The rules with one committee chosen or not, the rest as it was. With no
 * rules, choosing a committee starts rules that select only it. A committee
 * already listed stays as it is, with any narrowing it has.
 */
export function withCommittee(rules: EventRules | null, committee: { committeeId: string; name: string }, on: boolean): EventRules {
  const base = rules ?? EMPTY_EVENT_RULES
  const listed = base.committees.some(c => c.committeeId === committee.committeeId)
  if (on) {
    if (listed) return base
    return { ...base, committees: [...base.committees, { committeeId: committee.committeeId, name: committee.name }] }
  }
  return { ...base, committees: base.committees.filter(c => c.committeeId !== committee.committeeId) }
}

/** How one configurable state's events show: every event, or only the chosen committees. */
export type StateChoice = { mode: 'all' } | { mode: 'only'; committeeIds: string[] }

/**
 * One state's choice under `rules`, for the Calendar page's gear (#695).
 * `stateCommitteeIds` are the committees listed for that state. No rules, or a
 * state in `allStates`, is every event.
 */
export function stateChoice(rules: EventRules | null, state: string, stateCommitteeIds: readonly string[]): StateChoice {
  if (!rules || rules.allStates?.includes(state)) return { mode: 'all' }
  const mine = new Set(stateCommitteeIds)
  return { mode: 'only', committeeIds: rules.committees.map(c => c.committeeId).filter(id => mine.has(id)) }
}

/** The rules a state's choice edits: no rules means every configured state shows every event. */
function startingRules(rules: EventRules | null, configured: readonly string[]): EventRules {
  return rules ?? { ...EMPTY_EVENT_RULES, allStates: [...configured] }
}

/** Rules with `allStates` left off when empty, so a rule with no state shown in full is the shape saved before #695. */
function tidy(rules: EventRules, allStates: string[]): EventRules {
  const { allStates: _dropped, ...rest } = rules
  return allStates.length > 0 ? { ...rest, allStates } : rest
}

/**
 * The rules with one state shown in full, every other state as it was. Null
 * (no rules) once every configured state shows every event: the same as
 * choosing "All events" before there were states.
 */
export function withStateAll(rules: EventRules | null, state: string, configured: readonly string[], stateCommitteeIds: readonly string[]): EventRules | null {
  const base = startingRules(rules, configured)
  const allStates = [...new Set([...(base.allStates ?? []), state])]
  if (configured.every(s => allStates.includes(s))) return null
  const mine = new Set(stateCommitteeIds)
  return tidy({ ...base, committees: base.committees.filter(c => !mine.has(c.committeeId)) }, allStates)
}

/**
 * The rules with one state limited to `committees`, every other state as it
 * was: the state leaves `allStates`, and its committees are replaced.
 */
export function withStateOnly(rules: EventRules | null, state: string, configured: readonly string[], committees: readonly { committeeId: string; name: string }[], stateCommitteeIds: readonly string[]): EventRules | null {
  const base = startingRules(rules, configured)
  const mine = new Set(stateCommitteeIds)
  const kept = base.committees.filter(c => !mine.has(c.committeeId))
  const added = committees.map(({ committeeId, name }) => ({ committeeId, name }))
  return tidy({ ...base, committees: [...kept, ...added] }, (base.allStates ?? []).filter(s => s !== state))
}
