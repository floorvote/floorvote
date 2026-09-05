import { describe, it, expect } from 'vitest'
import { parseTagTaxonomy, aiInstructionsChanged, centralSyncWarning } from './aiConfig'
import { buildDefaultAiContext, buildDefaultRelevanceQuestion } from '../../../../shared/aiDefaults'
import { DEFAULT_TAXONOMY, serializeTaxonomy } from '../../../../shared/taxonomy'

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
  const base = {
    aiContext: 'a',
    relevanceQuestion: 'b',
    tagTaxonomy: 'c',
  }
  const ORG = 'Test Org'

  it('is false when all fields are identical', () => {
    expect(aiInstructionsChanged(base, { ...base }, ORG)).toBe(false)
  })

  it('is true when aiContext differs', () => {
    expect(aiInstructionsChanged(base, { ...base, aiContext: 'x' }, ORG)).toBe(true)
  })

  it('is true when relevanceQuestion differs', () => {
    expect(aiInstructionsChanged(base, { ...base, relevanceQuestion: 'x' }, ORG)).toBe(true)
  })

  it('is true when tagTaxonomy differs', () => {
    expect(aiInstructionsChanged(base, { ...base, tagTaxonomy: 'x' }, ORG)).toBe(true)
  })

  it('is false when a blank field is replaced by its own resolved default', () => {
    const blank = { ...base, aiContext: '', relevanceQuestion: '', tagTaxonomy: '' }
    const seeded = {
      ...base,
      aiContext: buildDefaultAiContext(ORG),
      relevanceQuestion: buildDefaultRelevanceQuestion(ORG),
      tagTaxonomy: serializeTaxonomy(DEFAULT_TAXONOMY),
    }
    expect(aiInstructionsChanged(blank, seeded, ORG)).toBe(false)
    expect(aiInstructionsChanged(seeded, blank, ORG)).toBe(false)
  })

  it('is false for a blank field and its resolved default under a non-fixture name', () => {
    const blank = { aiContext: '', relevanceQuestion: '', tagTaxonomy: '' }
    const seeded = {
      aiContext: buildDefaultAiContext('Other Org'),
      relevanceQuestion: buildDefaultRelevanceQuestion('Other Org'),
      tagTaxonomy: serializeTaxonomy(DEFAULT_TAXONOMY),
    }
    expect(aiInstructionsChanged(blank, seeded, 'Other Org')).toBe(false)
    expect(aiInstructionsChanged(seeded, blank, 'Other Org')).toBe(false)
  })

  it('ignores surrounding whitespace', () => {
    expect(aiInstructionsChanged(base, { ...base, aiContext: '  a  ' }, ORG)).toBe(false)
  })

  it('ignores tag-list reformatting that does not change the parsed taxonomy', () => {
    const a = { ...base, tagTaxonomy: 'Elections\nFunding' }
    const b = { ...base, tagTaxonomy: '  Elections  \n\n  Funding  ' }
    expect(aiInstructionsChanged(a, b, ORG)).toBe(false)
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
