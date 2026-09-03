import { describe, it, expect } from 'vitest'
import { parseTagTaxonomy, aiInstructionsChanged, centralSyncWarning } from './aiConfig'

describe('parseTagTaxonomy', () => {
  it('parses name-only lines', () => {
    expect(parseTagTaxonomy('Elections\nFunding')).toEqual({
      ok: true,
      value: [{ name: 'Elections' }, { name: 'Funding' }],
    })
  })

  it('parses name: description lines', () => {
    expect(parseTagTaxonomy('Elections: anything about voting')).toEqual({
      ok: true,
      value: [{ name: 'Elections', description: 'anything about voting' }],
    })
  })

  it('trims whitespace and skips blank lines', () => {
    expect(parseTagTaxonomy('  Elections  \n\n  Funding: money  \n')).toEqual({
      ok: true,
      value: [{ name: 'Elections' }, { name: 'Funding', description: 'money' }],
    })
  })

  it('treats an empty description after the colon as no description', () => {
    expect(parseTagTaxonomy('Elections:')).toEqual({
      ok: true,
      value: [{ name: 'Elections' }],
    })
  })

  it('returns an error when a line has a description but no name', () => {
    expect(parseTagTaxonomy(': orphan description')).toEqual({
      ok: false,
      error: 'Each tag must have a name before the colon.',
    })
  })

  it('returns an empty array for empty input', () => {
    expect(parseTagTaxonomy('')).toEqual({ ok: true, value: [] })
  })
})

describe('aiInstructionsChanged', () => {
  const base = { aiContext: 'a', relevanceQuestion: 'b', tagTaxonomy: 'c' }

  it('is false when all three fields are identical', () => {
    expect(aiInstructionsChanged(base, { ...base })).toBe(false)
  })

  it('is true when aiContext differs', () => {
    expect(aiInstructionsChanged(base, { ...base, aiContext: 'x' })).toBe(true)
  })

  it('is true when relevanceQuestion differs', () => {
    expect(aiInstructionsChanged(base, { ...base, relevanceQuestion: 'x' })).toBe(true)
  })

  it('is true when tagTaxonomy differs', () => {
    expect(aiInstructionsChanged(base, { ...base, tagTaxonomy: 'x' })).toBe(true)
  })
})

describe('centralSyncWarning', () => {
  const base = { queued: 3, demoted: 0, protectedAsManual: 0 }

  it('is silent when central succeeded', () => {
    expect(centralSyncWarning({ ...base, centralStatus: 'ok', centralEnriched: 5 })).toBeNull()
  })

  it('is silent when central succeeded with nothing to enrich', () => {
    expect(centralSyncWarning({ ...base, centralStatus: 'ok', centralEnriched: 0 })).toBeNull()
  })

  // The regression this guards: a 429 and an honest "nothing to enrich" both
  // arrive as centralEnriched: 0, so the count alone cannot tell them apart.
  it('warns when central was rate-limited, even though enriched is 0 either way', () => {
    const limited = centralSyncWarning({ ...base, centralStatus: 'rate_limited', centralEnriched: 0 })
    const healthy = centralSyncWarning({ ...base, centralStatus: 'ok', centralEnriched: 0 })
    expect(limited).toMatch(/rate-limited/i)
    expect(healthy).toBeNull()
  })

  it('warns when central could not be reached', () => {
    expect(centralSyncWarning({ ...base, centralStatus: 'failed' })).toMatch(/central/i)
  })

  it('warns when central truncated the batch', () => {
    expect(centralSyncWarning({ ...base, centralStatus: 'ok', centralTruncated: true })).toMatch(/save again/i)
  })

  it('stays silent when the API omits centralStatus (older backend)', () => {
    expect(centralSyncWarning(base)).toBeNull()
  })
})
