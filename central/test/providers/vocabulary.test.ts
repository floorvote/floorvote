import { describe, it, expect } from 'vitest'
import { PROVIDERS, getProvider } from '../../src/providers'
import { stagePosition } from '../../../shared/statusStages'
import { EXTRA_DISPLAYS } from '../../../shared/providerExtras'
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

  it('gives each extra its own label and a display type, and the provider a display name for their panel', () => {
    expect(provider.displayName.trim()).not.toBe('')
    const extras = Object.values(provider.vocabulary.extras ?? {})
    expect(new Set(extras.map(e => e.label)).size).toBe(extras.length)
    for (const e of extras) {
      expect(e.label.trim()).not.toBe('')
      expect(EXTRA_DISPLAYS, e.label).toContain(e.display)
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

  it('reads each of LIMS\'s 16 statuses, and no status, by the name LIMS gives it', () => {
    const lims = getProvider('lims').vocabulary.statuses
    expect(Object.keys(lims)).toHaveLength(17)
    for (const [code, s] of Object.entries(lims)) expect(limsStatusCode(s.label), s.label).toBe(Number(code))
    expect(limsStatusCode('')).toBe(100)
    expect(limsStatusCode('Something LIMS added later')).toBe(100)
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
