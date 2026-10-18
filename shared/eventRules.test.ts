import { describe, it, expect } from 'vitest'
import {
  COUNCIL_CALENDAR_TOPIC, EMPTY_EVENT_RULES, eventMatchesRules, hasLegacyParts, legacyNote, legacyParts, parseEventRules, rulesFromCouncilCalendar,
  withCommittee, withoutLegacyParts, stateChoice, withStateAll, withStateOnly,
  type EventFacets, type EventRules,
} from './eventRules'

const youth = { committeeId: '9001', name: 'Committee on Youth Affairs' }
const health = { committeeId: '9002', name: 'Committee on Health' }
const cow = { committeeId: '9003', name: 'Committee of the Whole' }

const event = (over: Partial<EventFacets> = {}): EventFacets => ({
  committeeId: youth.committeeId, committee: youth.name, jointWith: null,
  kind: 'hearing', type: 'Roundtable', title: 'Youth Affairs roundtable',
  topics: ['DYRS\' Fifth Rulemaking on Secure Detention'], ...over,
})
const rules = (over: Partial<EventRules>): EventRules => ({ ...EMPTY_EVENT_RULES, ...over })
const NONE = { tracked: false, prioritized: false }
const TRACKED = { tracked: true, prioritized: false }
const PRIORITIZED = { tracked: true, prioritized: true }

describe('eventMatchesRules', () => {
  it('selects nothing with empty rules', () => {
    expect(eventMatchesRules(event(), EMPTY_EVENT_RULES, TRACKED)).toBe(false)
  })

  it('selects a committee\'s events, and those it holds jointly', () => {
    const r = rules({ committees: [health] })
    expect(eventMatchesRules(event({ committeeId: health.committeeId }), r, NONE)).toBe(true)
    expect(eventMatchesRules(event({ jointWith: 'Joint with Human Services and Health' }), r, NONE)).toBe(true)
    expect(eventMatchesRules(event(), r, NONE)).toBe(false)
  })

  it('narrows a committee to one kind or event type', () => {
    const meetings = rules({ committees: [{ ...cow, kind: 'Meeting' }] })
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'meeting', type: 'Meeting' }), meetings, NONE)).toBe(true)
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'hearing', type: 'Hearing' }), meetings, NONE)).toBe(false)
    const markups = rules({ committees: [{ ...cow, kind: 'markup' }] })
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'markup', type: 'Mark-up' }), markups, NONE)).toBe(true)
  })

  it('selects a kind or an event type in any committee', () => {
    expect(eventMatchesRules(event(), rules({ kinds: ['hearing'] }), NONE)).toBe(true)
    expect(eventMatchesRules(event(), rules({ kinds: ['Roundtable'] }), NONE)).toBe(true)
    expect(eventMatchesRules(event(), rules({ kinds: ['Budget Oversight Hearing'] }), NONE)).toBe(false)
  })

  it('matches a topic\'s keywords against the title and the agenda', () => {
    expect(eventMatchesRules(event(), rules({ topics: [{ name: 'Youth', keywords: ['dyrs'] }] }), NONE)).toBe(true)
    expect(eventMatchesRules(event({ committeeId: null, title: 'Legislative Meeting', topics: [] }),
      rules({ topics: [{ name: 'Council', keywords: ['legislative meeting'] }] }), NONE)).toBe(true)
    expect(eventMatchesRules(event(), rules({ topics: [{ name: 'Housing', keywords: ['housing*'] }] }), NONE)).toBe(false)
  })

  it('never hides an event with a prioritized bill on its agenda', () => {
    expect(eventMatchesRules(event(), EMPTY_EVENT_RULES, PRIORITIZED)).toBe(true)
    expect(eventMatchesRules(event(), rules({ committees: [health] }), PRIORITIZED)).toBe(true)
  })

  it('compares event types without regard to case, and kinds exactly', () => {
    expect(eventMatchesRules(event(), rules({ kinds: ['roundtable'] }), NONE)).toBe(true)
    expect(eventMatchesRules(event(), rules({ committees: [{ ...youth, kind: 'ROUNDTABLE' }] }), NONE)).toBe(true)
    expect(eventMatchesRules(event(), rules({ kinds: ['Hearing'] }), NONE)).toBe(false)
  })

  it('selects an event with a tracked bill on its agenda only when the rule says so', () => {
    expect(eventMatchesRules(event(), rules({ trackedBills: true }), TRACKED)).toBe(true)
    expect(eventMatchesRules(event(), rules({ trackedBills: true }), NONE)).toBe(false)
    expect(eventMatchesRules(event(), rules({ trackedBills: false }), TRACKED)).toBe(false)
  })
})

describe('parseEventRules', () => {
  it('cleans and keeps valid rules', () => {
    expect(parseEventRules({
      committees: [{ committeeId: ' 9001 ', name: 'Committee on Youth Affairs', kind: '' }, { ...cow, kind: 'Meeting' }],
      kinds: ['Roundtable', 'Roundtable', ' markup '],
      topics: [{ name: 'Youth', keywords: ['dyrs', 'juvenile*'] }],
      trackedBills: true,
    })).toEqual({
      committees: [youth, { ...cow, kind: 'Meeting' }],
      kinds: ['Roundtable', 'markup'],
      topics: [{ name: 'Youth', keywords: ['dyrs', 'juvenile*'] }],
      trackedBills: true,
    })
    expect(parseEventRules({})).toEqual(EMPTY_EVENT_RULES)
  })

  it('refuses malformed rules', () => {
    expect(parseEventRules(null)).toBeTypeOf('string')
    expect(parseEventRules([])).toBeTypeOf('string')
    expect(parseEventRules({ committees: [{ committeeId: '1' }] })).toBeTypeOf('string')
    expect(parseEventRules({ committees: [youth, youth] })).toBeTypeOf('string')
    expect(parseEventRules({ kinds: [''] })).toBeTypeOf('string')
    expect(parseEventRules({ kinds: 'hearing' })).toBeTypeOf('string')
    expect(parseEventRules({ topics: [{ name: 'Empty', keywords: [] }] })).toBeTypeOf('string')
    expect(parseEventRules({ topics: [{ keywords: ['x'] }] })).toBeTypeOf('string')
    expect(parseEventRules({ trackedBills: 'yes' })).toBeTypeOf('string')
    expect(parseEventRules({ kinds: Array.from({ length: 201 }, (_, i) => `k${i}`) })).toBeTypeOf('string')
  })
})

describe('rulesFromCouncilCalendar', () => {
  const committees = [youth, health, cow]

  it('carries a fork team\'s DC Council calendar rules over', () => {
    expect(rulesFromCouncilCalendar({
      include: [
        { committee: 'Youth Affairs' }, { committee: 'Legislative Meeting' },
        { committee: 'Committee of the Whole', type: 'Meeting' }, { committee: 'Health', type: 'Roundtable' }, { committee: 'Health' },
      ],
      types: ['Budget Oversight Hearing'],
      topicKeywords: ['dyrs', 'juvenile*'],
      trackedBills: true,
    }, committees)).toEqual({
      committees: [youth, { ...cow, kind: 'Meeting' }, health],
      kinds: ['Budget Oversight Hearing'],
      topics: [{ name: COUNCIL_CALENDAR_TOPIC, keywords: ['dyrs', 'juvenile*', 'legislative meeting'] }],
      trackedBills: true,
    })
  })

  it('keeps every event of a committee the fork narrowed to two kinds', () => {
    // A team that chose Health's oversight hearings and its roundtables: a rule
    // holds one kind per committee, so the committee broadens rather than lose one.
    const r = rulesFromCouncilCalendar({
      include: [{ committee: 'Health', type: 'Oversight Hearing' }, { committee: 'Health', type: 'Roundtable' }],
    }, committees)!
    expect(r.committees).toEqual([health])
    expect(eventMatchesRules(event({ committeeId: health.committeeId, kind: 'hearing', type: 'Roundtable', title: 'Health roundtable' }), r, NONE)).toBe(true)
    // The same kind twice stays narrowed.
    expect(rulesFromCouncilCalendar({
      include: [{ committee: 'Health', type: 'Roundtable' }, { committee: 'Health', type: 'Roundtable' }],
    }, committees)!.committees).toEqual([{ ...health, kind: 'Roundtable' }])
  })

  it('keeps only each committee\'s id and name from central\'s list', () => {
    expect(rulesFromCouncilCalendar({ include: [{ committee: 'Health' }] }, [{ ...health, chamber: 'C', state: 'DC' } as typeof health])!.committees)
      .toEqual([health])
  })

  it('selects what the fork\'s rules selected', () => {
    const r = rulesFromCouncilCalendar({ include: [{ committee: 'Legislative Meeting' }, { committee: 'Committee of the Whole', type: 'Meeting' }] }, committees)!
    expect(eventMatchesRules(event({ committeeId: null, kind: 'meeting', type: 'Meeting', title: 'Legislative Meeting', topics: [] }), r, NONE)).toBe(true)
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'meeting', type: 'Meeting', title: 'Committee of the Whole meeting' }), r, NONE)).toBe(true)
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'hearing', type: 'Hearing', title: 'Committee of the Whole hearing' }), r, NONE)).toBe(false)
  })

  it('returns null for anything else', () => {
    expect(rulesFromCouncilCalendar(null, committees)).toBeNull()
    expect(rulesFromCouncilCalendar('x', committees)).toBeNull()
    expect(rulesFromCouncilCalendar({}, committees)).toEqual(EMPTY_EVENT_RULES)
  })
})

// The Calendar page's one control (#420) offers all events or chosen committees. A rule saved
// earlier may carry more, and it keeps matching exactly as before.
describe('legacy rules under the simplified control', () => {
  const legacy = rules({
    committees: [{ ...health, kind: 'Roundtable' }, youth],
    kinds: ['meeting'],
    topics: [{ name: 'Youth detention', keywords: ['secure detention'] }],
    trackedBills: true,
  })

  it('finds nothing extra in a committees-only rule, or in no rules', () => {
    expect(hasLegacyParts(legacyParts(null))).toBe(false)
    expect(hasLegacyParts(legacyParts(rules({ committees: [health, youth] })))).toBe(false)
    expect(hasLegacyParts(legacyParts(EMPTY_EVENT_RULES))).toBe(false)
  })

  it('finds kinds, event types, topics, tracked bills, and a committee narrowed to a kind', () => {
    expect(legacyParts(legacy)).toEqual({
      kinds: ['meeting'],
      topics: ['Youth detention'],
      trackedBills: true,
      narrowedCommittees: [{ name: health.name, kind: 'Roundtable' }],
    })
    expect(hasLegacyParts(legacyParts(rules({ kinds: ['Roundtable'] })))).toBe(true)
    expect(hasLegacyParts(legacyParts(rules({ trackedBills: true })))).toBe(true)
    expect(hasLegacyParts(legacyParts(rules({ topics: [{ name: 'T', keywords: ['k'] }] })))).toBe(true)
    expect(hasLegacyParts(legacyParts(rules({ committees: [{ ...cow, kind: 'markup' }] })))).toBe(true)
  })

  it('says it in one line that starts "Kept from an earlier setting:"', () => {
    const note = legacyNote(legacyParts(legacy))
    expect(note).toMatch(/^Kept from an earlier setting: /)
    expect(note).not.toContain('\n')
    expect(note).toContain('meeting')
    expect(note).toContain('Youth detention')
    expect(note).toContain('a bill we track')
    expect(note).toContain(health.name)
    expect(note).toContain('Roundtable')
    expect(legacyNote(legacyParts(rules({ trackedBills: true })))).toBe('Kept from an earlier setting: events with a bill we track.')
    expect(legacyNote(legacyParts(rules({ kinds: ['Roundtable', 'meeting'] })))).toBe('Kept from an earlier setting: every Roundtable event and every meeting event.')
  })

  it('keeps matching what it matched, as before', () => {
    // A committee narrowed to a kind.
    expect(eventMatchesRules(event({ committeeId: health.committeeId, type: 'Roundtable', kind: 'hearing' }), legacy, NONE)).toBe(true)
    expect(eventMatchesRules(event({ committeeId: health.committeeId, type: 'Hearing', kind: 'hearing', title: 'Other', topics: [] }), legacy, NONE)).toBe(false)
    // A kind in any committee.
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'meeting', type: 'Meeting', title: 'x', topics: [] }), legacy, NONE)).toBe(true)
    // A topic, against the title and agenda.
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'hearing', type: 'Hearing', title: 'Secure detention oversight', topics: [] }), legacy, NONE)).toBe(true)
    // A tracked bill on the agenda.
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'hearing', type: 'Hearing', title: 'x', topics: [] }), legacy, TRACKED)).toBe(true)
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'hearing', type: 'Hearing', title: 'x', topics: [] }), legacy, NONE)).toBe(false)
  })

  it('goes on parsing: a saved legacy rule survives parseEventRules unchanged', () => {
    expect(parseEventRules(legacy)).toEqual(legacy)
  })

  it('removes only the legacy parts, keeping every committee whole', () => {
    expect(withoutLegacyParts(legacy)).toEqual({ committees: [{ committeeId: health.committeeId, name: health.name }, youth], kinds: [], topics: [], trackedBills: false })
    const plain = rules({ committees: [health] })
    expect(withoutLegacyParts(plain)).toEqual(plain)
  })

  it('selects, once the legacy parts are removed, only the committees\' events and prioritized ones', () => {
    const simple = withoutLegacyParts(legacy)
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'meeting', type: 'Meeting', title: 'x', topics: [] }), simple, TRACKED)).toBe(false)
    expect(eventMatchesRules(event({ committeeId: health.committeeId, type: 'Hearing', kind: 'hearing', title: 'x', topics: [] }), simple, NONE)).toBe(true)
    expect(eventMatchesRules(event({ committeeId: cow.committeeId, kind: 'meeting', type: 'Meeting' }), simple, PRIORITIZED)).toBe(true)
  })
})

describe('withCommittee', () => {
  it('starts from no rules with the one committee, selecting nothing else', () => {
    const r = withCommittee(null, { committeeId: health.committeeId, name: health.name }, true)
    expect(r).toEqual({ committees: [health], kinds: [], topics: [], trackedBills: false })
    expect(eventMatchesRules(event({ committeeId: youth.committeeId }), r, TRACKED)).toBe(false)
  })

  it('adds a committee once and removes it, leaving the rest of the rule alone', () => {
    const base = rules({ committees: [{ ...youth, kind: 'Roundtable' }], kinds: ['meeting'], trackedBills: true })
    const added = withCommittee(base, health, true)
    expect(added.committees).toEqual([{ ...youth, kind: 'Roundtable' }, health])
    expect(added.kinds).toEqual(['meeting'])
    expect(added.trackedBills).toBe(true)
    expect(withCommittee(added, health, true).committees).toHaveLength(2)
    expect(withCommittee(added, health, false)).toEqual(base)
  })

  it('removes a committee even if it was narrowed to a kind', () => {
    const base = rules({ committees: [{ ...youth, kind: 'Roundtable' }, health] })
    expect(withCommittee(base, youth, false).committees).toEqual([health])
  })
})

describe('event rules per state (#695)', () => {
  const dc = { committeeId: '9101', name: 'Committee on Health' }
  const dc2 = { committeeId: '9102', name: 'Committee on Housing' }
  const md = { committeeId: '9201', name: 'Senate Finance Committee' }
  const md2 = { committeeId: '9202', name: 'House Appropriations Committee' }
  const DC_IDS = [dc.committeeId, dc2.committeeId]
  const MD_IDS = [md.committeeId, md2.committeeId]
  const BOTH = ['DC', 'MD']
  const inState = (state: string | null, over: Partial<EventFacets> = {}) => event({ state, ...over })

  it('parses allStates as a list of non-empty text, and leaves it out when empty or absent', () => {
    expect(parseEventRules({ committees: [], allStates: ['MD'] })).toEqual({ committees: [], kinds: [], topics: [], trackedBills: false, allStates: ['MD'] })
    expect(parseEventRules({ committees: [], allStates: [] })).toEqual(EMPTY_EVENT_RULES)
    expect(parseEventRules({ committees: [] })).toEqual(EMPTY_EVENT_RULES)
    expect(parseEventRules({ allStates: ['MD', 'MD', ' DC '] })).toMatchObject({ allStates: ['MD', 'DC'] })
    expect(typeof parseEventRules({ allStates: 'MD' })).toBe('string')
    expect(typeof parseEventRules({ allStates: [''] })).toBe('string')
  })

  it('selects every event of a state listed in allStates, and no other state\'s', () => {
    const r = rules({ committees: [dc], allStates: ['MD'] })
    expect(eventMatchesRules(inState('MD', { committeeId: md2.committeeId }), r, NONE)).toBe(true)
    expect(eventMatchesRules(inState('MD', { committeeId: null, committee: null }), r, NONE)).toBe(true)
    expect(eventMatchesRules(inState('DC', { committeeId: dc2.committeeId }), r, NONE)).toBe(false)
    expect(eventMatchesRules(inState('DC', { committeeId: dc.committeeId }), r, NONE)).toBe(true)
  })

  it('does not match an event with no state against allStates (an event described before states were kept)', () => {
    expect(eventMatchesRules(inState(null, { committeeId: md2.committeeId }), rules({ allStates: ['MD'] }), NONE)).toBe(false)
    expect(eventMatchesRules(event(), rules({ allStates: ['MD'] }), NONE)).toBe(false)
  })

  it('reads a state\'s choice: all with no rules or when listed, otherwise its chosen committees', () => {
    expect(stateChoice(null, 'DC', DC_IDS)).toEqual({ mode: 'all' })
    expect(stateChoice(rules({ allStates: ['DC'] }), 'DC', DC_IDS)).toEqual({ mode: 'all' })
    expect(stateChoice(rules({ committees: [dc, md] }), 'DC', DC_IDS)).toEqual({ mode: 'only', committeeIds: [dc.committeeId] })
    expect(stateChoice(rules({ committees: [dc, md] }), 'MD', MD_IDS)).toEqual({ mode: 'only', committeeIds: [md.committeeId] })
    expect(stateChoice(EMPTY_EVENT_RULES, 'DC', DC_IDS)).toEqual({ mode: 'only', committeeIds: [] })
  })

  it('with one state, only-these then all behave as before: empty rules, then null', () => {
    expect(withStateOnly(null, 'DC', ['DC'], [], DC_IDS)).toEqual(EMPTY_EVENT_RULES)
    expect(withStateOnly(null, 'DC', ['DC'], [dc], DC_IDS)).toEqual(rules({ committees: [dc] }))
    expect(withStateAll(rules({ committees: [dc], kinds: ['meeting'] }), 'DC', ['DC'], DC_IDS)).toBeNull()
  })

  it('with two states, filtering one leaves the other showing every event', () => {
    const r = withStateOnly(null, 'DC', BOTH, [dc], DC_IDS)!
    expect(r).toEqual(rules({ committees: [dc], allStates: ['MD'] }))
    expect(stateChoice(r, 'MD', MD_IDS)).toEqual({ mode: 'all' })
    expect(stateChoice(r, 'DC', DC_IDS)).toEqual({ mode: 'only', committeeIds: [dc.committeeId] })
  })

  it('with two states, changing one state never changes the other\'s committees', () => {
    let r = withStateOnly(null, 'DC', BOTH, [dc], DC_IDS)!
    r = withStateOnly(r, 'MD', BOTH, [md], MD_IDS)!
    expect(r).toEqual(rules({ committees: [dc, md] }))
    const afterAll = withStateAll(r, 'DC', BOTH, DC_IDS)!
    expect(afterAll).toEqual(rules({ committees: [md], allStates: ['DC'] }))
    expect(stateChoice(afterAll, 'MD', MD_IDS)).toEqual({ mode: 'only', committeeIds: [md.committeeId] })
    expect(withStateAll(afterAll, 'MD', BOTH, MD_IDS)).toBeNull()
  })

  it('replaces a state\'s committees on only-these, and keeps what a rule saved earlier holds', () => {
    const base = rules({ committees: [dc, md], kinds: ['meeting'], trackedBills: true })
    const r = withStateOnly(base, 'DC', BOTH, [dc2], DC_IDS)!
    expect(r.committees).toEqual([md, dc2])
    expect(r.kinds).toEqual(['meeting'])
    expect(r.trackedBills).toBe(true)
  })

  it('leaves allStates off the rules once no state is wholly shown', () => {
    const r = withStateOnly(rules({ committees: [dc], allStates: ['MD'] }), 'MD', BOTH, [md], MD_IDS)!
    expect(r).toEqual(rules({ committees: [dc, md] }))
    expect('allStates' in r).toBe(false)
  })
})
