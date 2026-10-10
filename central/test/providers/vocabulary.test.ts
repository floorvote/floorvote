import { describe, it, expect } from 'vitest'
import { PROVIDERS, getProvider } from '../../src/providers'
import { stagePosition } from '../../../shared/statusStages'
import { limsStatusCode } from '../../src/providers/lims/map'

// Every provider's vocabulary follows the same rules, which core and
// instances rely on: rank orders statuses across providers, and instances look
// a status up by its label.
describe.each(PROVIDERS.map(p => [p.id, p] as const))('%s vocabulary', (_id, provider) => {
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
})

describe('the codes each provider writes', () => {
  const codes = (id: string) => Object.keys(getProvider(id).vocabulary.statuses).map(Number).sort((a, b) => a - b)

  it('covers LegiScan\'s whole Status / Progress table', () => {
    expect(codes('legiscan')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('covers every code the Maryland and Virginia mappings derive', () => {
    expect(codes('mga')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(codes('lis')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
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
