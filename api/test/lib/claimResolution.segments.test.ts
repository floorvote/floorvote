import { describe, it, expect } from 'vitest'
import { resolveClaimSources, pruneClaimSources } from '../../src/lib/claimResolution'

// A quote the model stitched from separate passages (#802): each segment
// resolves on its own, so one claim links to several passages. Invented prose.

const S3 = 'Section 3. The secretary of the commonwealth shall adopt rules governing the location, lighting, and surveillance of each drop box.'
const S4 = 'Section 4. A drop box shall be emptied by two employees of the county election office at least once each business day.'
const S6 = 'Section 6. A person who tampers with a drop box commits a misdemeanor and may be fined not more than five hundred dollars.'
const DOC = [
  'Section 1. This act may be cited as the Ballot Drop Box Access Act.',
  'Section 2. Each county election office shall provide at least one secure drop box for the return of voted ballots.',
  S3, S4,
  'Section 5. The county shall report the number of ballots collected from each drop box to the secretary within ten days after an election.',
  S6,
].join('\n')
const CLAIM = 'Drop boxes are regulated.'

const resolve = (quote: string, doc: string | null = DOC) =>
  resolveClaimSources([{ claim: CLAIM, quote }], CLAIM, doc)

describe('a quote stitched from several passages', () => {
  it.each([
    ['spaced dots', ' ... '],
    ['an ellipsis character', ' … '],
    ['dots with no spaces', '...'],
  ])('resolves each of three exact passages joined with %s as its own linked item', (_name, joiner) => {
    // Dots right after a sentence's period read as one run, so that period goes with them.
    const parts = joiner === '...' ? [S3, S4, S6].map(p => p.slice(0, -1)) : [S3, S4, S6]
    const { items } = resolve(parts.join(joiner))
    expect(items).toHaveLength(3)
    expect(items.map(i => i.status)).toEqual(['exact', 'exact', 'exact'])
    expect(items.map(i => i.matched)).toEqual(parts)
    expect(items.map(i => DOC.slice(i.quoteAt!.start, i.quoteAt!.end))).toEqual(parts)
    expect(new Set(items.map(i => i.claim))).toEqual(new Set([CLAIM]))
    expect(new Set(items.map(i => i.claimAt.start))).toEqual(new Set([0]))
    expect(items.map(i => i.quote)).toEqual(parts)
  })

  it('resolves a segment that differs only in whitespace as normalized', () => {
    const { items } = resolve(`${S3} ... ${S4.replace('Section 4. ', 'Section  4.\n')}`)
    expect(items.map(i => i.status)).toEqual(['exact', 'normalized'])
  })

  it('leaves a segment that is not in the bill ungrounded, and still links the others', () => {
    const { items } = resolve(`${S3} ... The clerk shall notify every registered voter of the new program by mail. ... ${S6}`)
    expect(items.map(i => i.status)).toEqual(['exact', 'ungrounded', 'exact'])
    expect(items[1].quoteAt).toBeUndefined()
    expect(items[2].matched).toBe(S6)
  })

  it('resolves a quote with dots inside one passage as one passage, by the whole-quote check before splitting', () => {
    const doc = 'Section 1. The board shall act... and then the board shall report to the clerk.\nSection 2. Other text.'
    const quote = 'The board shall act... and then the board shall report to the clerk.'
    const { items } = resolveClaimSources([{ claim: CLAIM, quote }], CLAIM, doc)
    expect(items).toHaveLength(1)
    expect(items[0].status).toBe('exact')
    expect(items[0].matched).toBe(quote)
  })

  it('resolves a quote with a lone leading or trailing ellipsis as the passage without it', () => {
    const lead = resolve('\u2026 shall adopt rules governing the location, lighting, and surveillance')
    expect(lead.items).toHaveLength(1)
    expect(lead.items[0].status).toBe('exact')
    expect(lead.items[0].quote).toBe('shall adopt rules governing the location, lighting, and surveillance')
    const trail = resolve('Section 4. A drop box shall be emptied by two employees ...')
    expect(trail.items[0].status).toBe('exact')
    expect(trail.items[0].matched).toBe('Section 4. A drop box shall be emptied by two employees')
  })

  it('counts each segment toward the cap on items searched', () => {
    const quote = Array.from({ length: 120 }, () => S3).join(' ... ')
    const { items, capped } = resolve(quote)
    expect(items).toHaveLength(120)
    expect(capped).toBe(20)
  })

  it('is replaced as a list on re-analysis: every segment follows its claim, and goes with it', () => {
    const { items } = resolve(`${S3} ... ${S4}`)
    expect(items).toHaveLength(2)
    const kept = pruneClaimSources(items, `New opening. ${CLAIM}`)
    expect(kept.map(i => i.claimAt)).toEqual([{ start: 13, end: 13 + CLAIM.length }, { start: 13, end: 13 + CLAIM.length }])
    expect(pruneClaimSources(items, 'Nothing like it.')).toEqual([])
  })
})
