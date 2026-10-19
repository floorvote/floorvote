import { describe, it, expect, vi } from 'vitest'
import { PROVIDERS, getProvider } from '../../src/providers'
import { stagePosition } from '../../../shared/statusStages'
import { EXTRA_DISPLAYS, EXTRA_PLACEMENTS } from '../../../shared/providerExtras'
import { CALENDAR_KINDS } from '../../../shared/calendarKinds'
import { RELATIONSHIP_KINDS } from '../../../shared/relationshipKinds'
import { limsStatusCode } from '../../src/providers/lims/map'
import { example } from './example'
import { LEGACY_STATUS_ORDER, LEGISCAN_CODE_WORDS } from '../../../shared/legacyStatusOrder'

// Every provider's vocabulary follows the same rules, which core and
// instances rely on: rank orders statuses across providers, and instances look
// a status up by its label. The test-only example provider is the one that
// declares extras so far.
describe.each([...PROVIDERS, example].map(p => [p.id, p] as const))('%s vocabulary', (_id, provider) => {
  const statuses = Object.values(provider.vocabulary.statuses)

  it('ranks each status by its stage position times 100 plus its order within the stage', () => {
    for (const s of statuses) {
      if (s.stage === null) {
        expect(s.rank, s.label).toBe(0)
      } else {
        expect(Math.floor(s.rank / 100), s.label).toBe(stagePosition(s.stage))
        expect(s.rank % 100, s.label).toBeGreaterThan(0)
      }
    }
  })

  it('gives each status its own label and rank, and an explainer', () => {
    expect(new Set(statuses.map(s => s.label)).size).toBe(statuses.length)
    expect(new Set(statuses.map(s => s.rank)).size).toBe(statuses.length)
    for (const s of statuses) expect(s.explainer.trim(), s.label).not.toBe('')
  })

  it('labels its bill types and event types', () => {
    expect(Object.keys(provider.vocabulary.billTypes).length).toBeGreaterThan(0)
    for (const t of [...Object.values(provider.vocabulary.billTypes), ...Object.values(provider.vocabulary.eventTypes)]) {
      expect(t.label.trim()).not.toBe('')
    }
  })

  it('names the kind of each event type, which central sends with every calendar entry', () => {
    for (const t of Object.values(provider.vocabulary.eventTypes)) expect(CALENDAR_KINDS, t.label).toContain(t.kind)
  })

  it('gives each extra its own label and a display type, and the provider a display name for their panel', () => {
    expect(provider.displayName.trim()).not.toBe('')
    const extras = Object.values(provider.vocabulary.extras ?? {})
    expect(new Set(extras.map(e => e.label)).size).toBe(extras.length)
    for (const e of extras) {
      expect(e.label.trim()).not.toBe('')
      expect(EXTRA_DISPLAYS, e.label).toContain(e.display)
    }
  })

  it('gives each extra a placement the bill page knows, or none, which means the panel', () => {
    for (const e of Object.values(provider.vocabulary.extras ?? {})) {
      if (e.placement !== undefined) expect(EXTRA_PLACEMENTS, e.label).toContain(e.placement)
    }
  })

  it('shows an extra flag only when its value could be "Yes"', () => {
    // A flag's value is "Yes" (anything else falls back to a meta item), so its label names the thing that is true.
    for (const e of Object.values(provider.vocabulary.extras ?? {})) {
      if (e.placement === 'flag') expect(e.label.trim(), e.label).not.toMatch(/[:?]$/)
    }
  })

  it('maps each relationship label to one of the three kinds, with state overrides keyed by state', () => {
    const r = provider.vocabulary.relationships
    if (!r) return
    const maps = [r.default, ...Object.values(r.states ?? {})]
    for (const state of Object.keys(r.states ?? {})) expect(state).toMatch(/^[A-Z]{2}$/)
    for (const map of maps) {
      for (const [label, kind] of Object.entries(map)) {
        expect(label.trim(), 'a label').not.toBe('')
        expect(RELATIONSHIP_KINDS, label).toContain(kind)
      }
    }
  })
})

describe('the codes each provider writes', () => {
  const codes = (id: string) => Object.keys(getProvider(id).vocabulary.statuses).map(Number).sort((a, b) => a - b)

  it('covers LegiScan\'s whole Status / Progress table', () => {
    expect(codes('legiscan')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('covers every code the Maryland and Virginia mappings derive', () => {
    expect(codes('mga')).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216])
    expect(codes('lis')).toEqual([301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312])
  })

  it('covers the eleven statuses the GovInfo derivation writes, in the 400s', () => {
    expect(codes('govinfo')).toEqual([401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411])
    const statuses = getProvider('govinfo').vocabulary.statuses
    expect(Object.values(statuses).map(s => s.label)).toEqual([
      'Introduced', 'In committee', 'Reported', 'Passed House', 'Passed Senate', 'Passed both chambers',
      'Presented to the President', 'Failed', 'Vetoed', 'Became law', 'Agreed to',
    ])
    // A law and an agreed-to resolution are done. Everything else can still move, a failed vote and a veto included.
    expect(Object.values(statuses).filter(s => s.terminal).map(s => s.label)).toEqual(['Became law', 'Agreed to'])
  })

  it('declares the four GovInfo bill types and the four extras later tickets fill', () => {
    const v = getProvider('govinfo').vocabulary
    expect(Object.keys(v.billTypes).sort()).toEqual(['B', 'CR', 'JR', 'R'])
    expect(Object.fromEntries(Object.entries(v.extras ?? {}).map(([k, e]) => [k, e.display]))).toEqual({
      summary: 'text', publicLaw: 'identifier', policyArea: 'text', costEstimate: 'link',
    })
  })

  it('reads each of LIMS\'s 16 statuses, and no status, by the name LIMS gives it', () => {
    const lims = getProvider('lims').vocabulary.statuses
    expect(Object.keys(lims)).toHaveLength(17)
    for (const [code, s] of Object.entries(lims)) expect(limsStatusCode(s.label), s.label).toBe(Number(code))
    expect(limsStatusCode('')).toBe(100)
    expect(limsStatusCode('Something LIMS added later')).toBe(100)
  })

  it('warns when it meets a status name it doesn\'t list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    limsStatusCode('Brand New Status')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Brand New Status'))
    warn.mockClear()
    limsStatusCode('')
    limsStatusCode('Not Applicable')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the relationship labels each provider maps', () => {
  const relationships = (id: string) => getProvider(id).vocabulary.relationships

  it('maps LegiScan\'s "Same As" and "Crossfiled" to identical, and Michigan\'s "Same As" to package', () => {
    expect(relationships('legiscan')?.default).toMatchObject({ 'Same As': 'identical', 'Crossfiled': 'identical' })
    expect(relationships('legiscan')?.states).toEqual({ MI: { 'Same As': 'package' } })
  })

  it('maps Maryland\'s "Cross-filed" to identical', () => {
    expect(relationships('mga')?.default).toMatchObject({ 'Cross-filed': 'identical' })
  })

  it('maps Congress\'s "Identical bill" to identical, and its other labels to related', () => {
    expect(relationships('govinfo')?.default).toMatchObject({
      'Identical bill': 'identical',
      'Related bill': 'related',
      'Procedurally related': 'related',
    })
    expect(Object.entries(relationships('govinfo')!.default).filter(([, k]) => k === 'identical').map(([l]) => l)).toEqual(['Identical bill'])
  })
})

describe('LegiScan ranks', () => {
  it('sort statuses in the order instances have always sorted them', () => {
    // The order of the status sort's old hand-written CASE, lowest first.
    const old = [12, 0, 1, 9, 11, 10, 2, 3, 6, 5, 4, 7, 8]
    const statuses = getProvider('legiscan').vocabulary.statuses
    const ranks = old.map(code => statuses[code].rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })
})

describe('terminal statuses', () => {
  const terminal = (id: string) => Object.values(getProvider(id).vocabulary.statuses).filter(s => s.terminal).map(s => s.label)

  it('leave DC\'s Approved and Deemed Approved open, and close its final outcomes', () => {
    expect(terminal('lims')).not.toContain('Approved')
    expect(terminal('lims')).not.toContain('Deemed Approved')
    expect(terminal('lims')).toEqual(expect.arrayContaining(['Official Law', 'Withdrawn', 'Failed', 'Disapproved', 'Deemed Disapproved', 'Expired', 'Not Applicable']))
  })
})

// Instances backfilled stage and rank from shared/legacyStatusOrder.ts
// (migration 0076), and fall back to it for a central that sends no rank. It
// must agree with what central sends.
describe('the instances\' legacy status table', () => {
  const legiscan = getProvider('legiscan').vocabulary.statuses
  const lims = getProvider('lims').vocabulary.statuses

  it('matches LegiScan\'s vocabulary for every label and bare code', () => {
    for (const [code, s] of Object.entries(legiscan)) {
      expect(LEGACY_STATUS_ORDER[s.label], s.label).toEqual({ stage: s.stage, rank: s.rank })
      expect(LEGACY_STATUS_ORDER[code], code).toEqual({ stage: s.stage, rank: s.rank })
    }
  })

  it('names LegiScan\'s progress codes with the labels central sends', () => {
    for (const [code, word] of Object.entries(LEGISCAN_CODE_WORDS)) expect(legiscan[Number(code)].label).toBe(word)
  })

  it('matches LIMS\'s vocabulary for every status name LegiScan doesn\'t also use', () => {
    const legiscanLabels = new Set(Object.values(legiscan).map(s => s.label))
    for (const s of Object.values(lims)) {
      if (s.stage === null || legiscanLabels.has(s.label)) continue
      expect(LEGACY_STATUS_ORDER[s.label], s.label).toEqual({ stage: s.stage, rank: s.rank })
    }
  })
})

describe('where each provider\'s extras go on the bill page', () => {
  const placements = (id: string) => {
    const by: Record<string, string[]> = { meta: [], detail: [], flag: [], panel: [] }
    for (const [key, e] of Object.entries(getProvider(id).vocabulary.extras ?? {})) by[e.placement ?? 'panel'].push(key)
    return by
  }

  it('declares Maryland\'s chapter and between-chambers step as meta, statutes as detail, and both flags with the flag placement', () => {
    expect(placements('mga')).toEqual({
      meta: ['chapter', 'chamberInteraction'], detail: ['statutes'], flag: ['emergency', 'constitutionalAmendment'], panel: [],
    })
  })

  it('declares Virginia\'s chapter as meta, the emergency flag with the flag placement, and the summaries in the panel, latest stage first', () => {
    expect(placements('lis')).toEqual({
      meta: ['chapter'], detail: [], flag: ['emergency'],
      panel: ['summaryPassed', 'summaryPassedSenate', 'summaryPassedHouse', 'summaryIntroduced'],
    })
  })

  it('declares DC\'s numbers, requester, withdrawal, and effective date as meta, and its comment committees as detail', () => {
    expect(placements('lims')).toEqual({
      meta: ['lawNumber', 'actNumber', 'resolutionNumber', 'requestedBy', 'lawEffective', 'withdrawnBy'],
      detail: ['commentCommittees'], flag: [], panel: [],
    })
  })

  it('no longer declares the ten DC dates that repeat the timeline', () => {
    const keys = Object.keys(getProvider('lims').vocabulary.extras ?? {})
    for (const gone of ['sentToMayor', 'mayorDeadline', 'signedByMayor', 'vetoedByMayor', 'enacted', 'actExpires', 'sentToCongress', 'projectedLawDate', 'lawExpires', 'withdrawnOn']) {
      expect(keys, gone).not.toContain(gone)
    }
  })

  it('offers exactly the four placements the ticket defines', () => {
    expect(EXTRA_PLACEMENTS).toEqual(['meta', 'detail', 'flag', 'panel'])
  })
})
