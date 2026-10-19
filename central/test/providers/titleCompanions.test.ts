import { describe, it, expect } from 'vitest'
import { PROVIDERS, getProvider, type Provider } from '../../src/providers'
import { titleCompanionConflicts, titleCompanionKey, titleCompanionsOn } from '../../src/lib/vocabulary'
import { normalizeTitle, titleKey } from '../../../shared/titleCompanions'
import { example } from './example'

// Title-matched companion suggestions (#521) are opted into per state, in the
// vocabulary of the state's provider, the way relationship labels are mapped.
// They stay off where the provider already names identical companions, so two
// sources of grouping never compete, and where titles are short subject
// headings, since a same-title pair there is a weak signal.

// Left off at launch, by the triage decision of October 16, 2026: titles are
// subject headings in these, and the provider labels companions in the last three.
const LEFT_OFF_AT_LAUNCH = ['CA', 'IN', 'IL', 'AZ', 'VA', 'NJ', 'TX', 'WA']

const TITLE = 'An act relating to elections and the registration of voters'
const legiscan = () => getProvider('legiscan')

// A provider like the example, with its own relationships and title companions.
function providerWith(vocabulary: Partial<Provider['vocabulary']>): Provider {
  return { ...example, vocabulary: { ...example.vocabulary, ...vocabulary } } as Provider
}

describe('the states each provider opts in', () => {
  it('opts in Rhode Island, Pennsylvania, and Michigan on LegiScan, for bills only', () => {
    expect([...legiscan().vocabulary.titleCompanions!.states].sort()).toEqual(['MI', 'PA', 'RI'])
    expect(legiscan().vocabulary.titleCompanions!.billTypes).toEqual(['B'])
  })

  it('records the states whose LegiScan feeds carry identical labels', () => {
    expect([...legiscan().vocabulary.relationships!.identicalStates!].sort()).toEqual(['NJ', 'TX', 'US', 'WA', 'WI'])
    expect(getProvider('mga').vocabulary.relationships!.identicalStates).toEqual(['MD'])
    expect(getProvider('govinfo').vocabulary.relationships!.identicalStates).toEqual(['US'])
  })

  // Every opted-in state, with its provider. Not empty, so the checks below can't pass on nothing.
  const opted = [...PROVIDERS, example].flatMap(p => (p.vocabulary.titleCompanions?.states ?? []).map(state => ({ provider: p, state })))

  it('opts in no state where its provider labels companions', () => {
    expect(opted.length).toBeGreaterThan(0)
    for (const p of [...PROVIDERS, example]) expect(titleCompanionConflicts(p), p.id).toEqual([])
  })

  it('opts in none of the states left off at launch', () => {
    expect(opted.length).toBeGreaterThan(0)
    for (const { provider, state } of opted) expect(LEFT_OFF_AT_LAUNCH, `${provider.id} ${state}`).not.toContain(state)
  })

  it('names each state by its two-letter abbreviation', () => {
    expect(opted.length).toBeGreaterThan(0)
    for (const { state } of opted) expect(state).toMatch(/^[A-Z]{2}$/)
  })

  it('makes only declared bill types eligible, and never a resolution', () => {
    const types = [...PROVIDERS, example].flatMap(p => (p.vocabulary.titleCompanions?.billTypes ?? []).map(type => ({ provider: p, type })))
    expect(types.length).toBeGreaterThan(0)
    for (const { provider, type } of types) {
      const declared = Object.entries(provider.vocabulary.billTypes).find(([value]) => value.toLowerCase() === type.toLowerCase())
      expect(declared, `${provider.id} ${type}`).toBeDefined()
      expect(declared![1].label, type).not.toMatch(/resolution/i)
    }
  })
})

describe('titleCompanionConflicts', () => {
  it('names an opted-in state the provider records as carrying identical labels', () => {
    const p = providerWith({
      relationships: { default: { 'Same As': 'identical' }, identicalStates: ['NJ'] },
      titleCompanions: { states: ['NJ', 'PA'], billTypes: ['B'] },
    })
    expect(titleCompanionConflicts(p)).toEqual(['NJ'])
  })

  it('names an opted-in state whose own override maps a label to identical', () => {
    const p = providerWith({
      relationships: { default: {}, states: { PA: { 'Twin': 'identical' }, MI: { 'Same As': 'package' } } },
      titleCompanions: { states: ['PA', 'MI'], billTypes: ['B'] },
    })
    expect(titleCompanionConflicts(p)).toEqual(['PA'])
  })

  it('names nothing for a provider that opts in no state', () => {
    const p = providerWith({ relationships: { default: { 'Same As': 'identical' }, identicalStates: ['NJ'] } })
    expect(titleCompanionConflicts(providerWith({ ...p.vocabulary, titleCompanions: { states: ['NJ'], billTypes: ['B'] } }))).toEqual(['NJ'])
    expect(titleCompanionConflicts(p)).toEqual([])
  })
})

describe('titleCompanionsOn', () => {
  it('is on for a state the provider opts in', () => {
    expect(titleCompanionsOn(legiscan(), 'RI')).toBe(true)
    expect(titleCompanionsOn(legiscan(), 'PA')).toBe(true)
  })

  it('is off for every state left off at launch, and any state not opted in', () => {
    expect(titleCompanionsOn(legiscan(), 'RI')).toBe(true)
    for (const state of [...LEFT_OFF_AT_LAUNCH, 'WI', 'US', 'NV', 'UT', 'WY']) expect(titleCompanionsOn(legiscan(), state), state).toBe(false)
  })

  it('stays off for an opted-in state that also carries identical labels, whatever the list says', () => {
    const p = providerWith({
      relationships: { default: { 'Same As': 'identical' }, identicalStates: ['NJ'] },
      titleCompanions: { states: ['NJ', 'PA'], billTypes: ['B'] },
    })
    expect(titleCompanionsOn(p, 'PA')).toBe(true)
    expect(titleCompanionsOn(p, 'NJ')).toBe(false)
  })

  it('is off for every state of a provider with no title companions', () => {
    expect(titleCompanionsOn(legiscan(), 'RI')).toBe(true)
    expect(titleCompanionsOn(getProvider('mga'), 'MD')).toBe(false)
    expect(titleCompanionsOn(getProvider('lis'), 'VA')).toBe(false)
  })
})

describe('titleCompanionKey', () => {
  const bill = (overrides: Partial<{ state: string; billType: string | null; body: string | null; title: string }> = {}) =>
    ({ state: 'RI', billType: 'B', body: 'H', title: TITLE, ...overrides })

  it('keys a bill in an opted-in state as the shared matcher does', () => {
    const key = titleCompanionKey(legiscan(), bill())
    expect(key).toBe(titleKey({ title: TITLE, billType: 'B', chamber: 'H' }, ['B']))
    expect(key).toContain(normalizeTitle(TITLE))
  })

  it('gives a House bill and a Senate bill with titles that differ in case and punctuation one key', () => {
    const h = titleCompanionKey(legiscan(), bill({ body: 'H', title: TITLE.toUpperCase() }))
    const s = titleCompanionKey(legiscan(), bill({ body: 'S', title: `${TITLE.replace('elections', 'elections,')}.` }))
    expect(h).not.toBeNull()
    expect(h).toBe(s)
  })

  it('keys no bill in a state that is not opted in', () => {
    expect(titleCompanionKey(legiscan(), bill())).not.toBeNull()
    for (const state of LEFT_OFF_AT_LAUNCH) expect(titleCompanionKey(legiscan(), bill({ state })), state).toBeNull()
  })

  it('keys no resolution', () => {
    expect(titleCompanionKey(legiscan(), bill())).not.toBeNull()
    for (const billType of ['R', 'JR', 'CR']) expect(titleCompanionKey(legiscan(), bill({ billType })), billType).toBeNull()
  })

  it('keys no stub, whose chamber central has not read yet', () => {
    expect(titleCompanionKey(legiscan(), bill())).not.toBeNull()
    expect(titleCompanionKey(legiscan(), bill({ body: '' }))).toBeNull()
    expect(titleCompanionKey(legiscan(), bill({ body: null }))).toBeNull()
  })

  it('keys no short or empty title', () => {
    expect(titleCompanionKey(legiscan(), bill())).not.toBeNull()
    expect(titleCompanionKey(legiscan(), bill({ title: 'Elections' }))).toBeNull()
    expect(titleCompanionKey(legiscan(), bill({ title: '' }))).toBeNull()
  })

  it('reads the opt-in from the bill\'s own provider', () => {
    expect(titleCompanionKey(legiscan(), bill({ state: 'RI' }))).not.toBeNull()
    expect(titleCompanionKey(getProvider('mga'), bill({ state: 'RI' }))).toBeNull()
  })
})
