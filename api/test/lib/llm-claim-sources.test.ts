import { describe, it, expect, vi, beforeEach } from 'vitest'

// Claim sources in the analysis call (#568, design in #560): the schema asks for
// them as its last property, with the instructions only in field descriptions,
// and a missing or malformed answer never fails the analysis.

const geminiGenerateMock = vi.hoisted(() => vi.fn())
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent: geminiGenerateMock } }
  }),
  ServiceTier: { FLEX: 'flex', STANDARD: 'standard', PRIORITY: 'priority', UNSPECIFIED: 'unspecified' },
}))

import { processBill, buildAnalysisSchema } from '../../src/lib/llm'
import type { Env } from '../../src/types'

const env = { GEMINI_API_KEY: 'k', TENANT_ID: 't' } as unknown as Env

// The wording #347 tested. Copied here rather than imported so a change to the
// descriptions fails this test instead of silently moving along with it.
const CLAIM_SOURCES_DESCRIPTION = 'one entry for each distinct claim in the summary'
const CLAIM_DESCRIPTION = 'copied character for character from the summary above: one whole list item (without the leading "- ") or one sentence or clause of prose'
const QUOTE_DESCRIPTION = 'copied character for character from the bill text: one short contiguous passage (one sentence or less is best) that supports the claim; never paraphrase, abbreviate, correct, add ellipses, or join separate passages'
const PAGE_DESCRIPTION = 'the page of this PDF file the quote is on, counting the first page of the file as 1 (the position in the file, not a printed page number)'

const html = { billNumber: 'HB 1', title: 'T', text: 'Section 1. Text.', taxonomy: [{ name: 'Voting' }] }
const pdf = { ...html, pdfBase64: btoa('%PDF fake') }
const good = { affectedCitations: [], summary: 'Moves the filing deadline.', tags: ['Voting'], relevanceScore: 6 }

function respond(payload: unknown) {
  geminiGenerateMock.mockResolvedValue({ text: JSON.stringify(payload) })
}
const schemaSent = () => geminiGenerateMock.mock.calls[0][0].config.responseSchema

beforeEach(() => {
  geminiGenerateMock.mockReset()
  respond(good)
})

describe('the schema asks for claim sources', () => {
  it('adds claimSources as the last property, after relevanceScore', async () => {
    await processBill({ ...html, claimSources: true }, env)
    const schema = schemaSent()
    expect(schema.propertyOrdering).toEqual(['affectedCitations', 'summary', 'tags', 'relevanceScore', 'claimSources'])
    expect(Object.keys(schema.properties).at(-1)).toBe('claimSources')
    expect(schema.required).toContain('claimSources')
  })

  it('asks HTML calls for {claim, quote} items, worded as #347 tested', async () => {
    await processBill({ ...html, claimSources: true }, env)
    const prop = schemaSent().properties.claimSources
    expect(prop.type).toBe('array')
    expect(prop.description).toBe(CLAIM_SOURCES_DESCRIPTION)
    expect(prop.items.type).toBe('object')
    expect(Object.keys(prop.items.properties)).toEqual(['claim', 'quote'])
    expect(prop.items.properties.claim).toEqual({ type: 'string', description: CLAIM_DESCRIPTION })
    expect(prop.items.properties.quote).toEqual({ type: 'string', description: QUOTE_DESCRIPTION })
    expect(prop.items.propertyOrdering).toEqual(['claim', 'quote'])
    expect(prop.items.required).toEqual(['claim', 'quote'])
  })

  it('asks PDF calls for {claim, quote, page} items', async () => {
    await processBill({ ...pdf, claimSources: true }, env)
    const prop = schemaSent().properties.claimSources
    expect(Object.keys(prop.items.properties)).toEqual(['claim', 'quote', 'page'])
    expect(prop.items.properties.page).toEqual({ type: 'integer', description: PAGE_DESCRIPTION })
    expect(prop.items.propertyOrdering).toEqual(['claim', 'quote', 'page'])
    expect(prop.items.required).toEqual(['claim', 'quote', 'page'])
  })

  it('leaves the schema exactly as before when claim sources are not asked for', async () => {
    await processBill(html, env)
    await processBill({ ...html, claimSources: false }, env)
    for (const [call] of geminiGenerateMock.mock.calls) {
      const schema = call.config.responseSchema
      expect(schema.properties).not.toHaveProperty('claimSources')
      expect(schema.propertyOrdering).toEqual(['affectedCitations', 'summary', 'tags', 'relevanceScore'])
      expect(schema.required).toEqual(['affectedCitations', 'summary', 'tags', 'relevanceScore'])
      expect(JSON.stringify(schema)).not.toMatch(/claim/i)
    }
  })

  it('builds exactly the schema it built before claim sources existed when not asked', () => {
    const before = {
      type: 'object',
      properties: {
        affectedCitations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Statutory citations this bill affects, exactly as printed in the bill.',
        },
        summary: { type: 'string' },
        tags: { type: 'array', items: { type: 'string', format: 'enum', enum: ['Voting', 'Local Government'] } },
        relevanceScore: { type: 'integer', description: 'An integer from 1 to 10 inclusive.' },
      },
      propertyOrdering: ['affectedCitations', 'summary', 'tags', 'relevanceScore'],
      required: ['affectedCitations', 'summary', 'tags', 'relevanceScore'],
      additionalProperties: false,
    }
    const tax = [{ name: 'Voting' }, { name: 'Local Government', description: 'counties' }]
    expect(buildAnalysisSchema(tax)).toEqual(before)
    expect(buildAnalysisSchema(tax, null)).toEqual(before)
  })

  it('builds the same schema directly, for each input kind', () => {
    const tax = [{ name: 'Voting' }]
    expect(buildAnalysisSchema(tax)).toEqual(buildAnalysisSchema(tax, null))
    expect(buildAnalysisSchema(tax, 'html').properties.claimSources.items.properties).not.toHaveProperty('page')
    expect(buildAnalysisSchema(tax, 'pdf').properties.claimSources.items.properties).toHaveProperty('page')
  })

  it('names nothing citations and leaves affectedCitations as it was', async () => {
    await processBill({ ...pdf, claimSources: true }, env)
    const schema = schemaSent()
    expect(Object.keys(schema.properties).filter(k => /citation/i.test(k))).toEqual(['affectedCitations'])
    expect(schema.properties.affectedCitations).toEqual({
      type: 'array', items: { type: 'string' },
      description: 'Statutory citations this bill affects, exactly as printed in the bill.',
    })
    expect(JSON.stringify(schema.properties.claimSources)).not.toMatch(/citation/i)
  })
})

describe('reading claim sources from the response', () => {
  it('returns HTML items verbatim, as {claim, quote}', async () => {
    respond({ ...good, claimSources: [
      { claim: 'Moves the filing deadline.', quote: 'the deadline is moved to May 1' },
      { claim: '  keeps its spacing ', quote: ' and this too ' },
    ] })
    const r = await processBill({ ...html, claimSources: true }, env)
    expect(r.claimSources).toEqual([
      { claim: 'Moves the filing deadline.', quote: 'the deadline is moved to May 1' },
      { claim: '  keeps its spacing ', quote: ' and this too ' },
    ])
  })

  it('returns PDF items with their page', async () => {
    respond({ ...good, claimSources: [{ claim: 'Moves the filing deadline.', quote: 'May 1', page: 3 }] })
    const r = await processBill({ ...pdf, claimSources: true }, env)
    expect(r.claimSources).toEqual([{ claim: 'Moves the filing deadline.', quote: 'May 1', page: 3 }])
  })

  it('drops a page an HTML item should not have', async () => {
    respond({ ...good, claimSources: [{ claim: 'c', quote: 'q', page: 2 }] })
    const r = await processBill({ ...html, claimSources: true }, env)
    expect(r.claimSources).toEqual([{ claim: 'c', quote: 'q' }])
  })

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -2],
    ['fractional', 2.5],
    ['a string', '3'],
    ['null', null],
  ])('keeps a PDF item whose page is %s, with a null page', async (_label, page) => {
    respond({ ...good, claimSources: [{ claim: 'c', quote: 'q', ...(page === undefined ? {} : { page }) }] })
    const r = await processBill({ ...pdf, claimSources: true }, env)
    expect(r.claimSources).toEqual([{ claim: 'c', quote: 'q', page: null }])
  })

  it.each([
    ['missing', {}],
    ['null', { claimSources: null }],
    ['a string', { claimSources: 'none' }],
    ['a number', { claimSources: 7 }],
    ['an object', { claimSources: { claim: 'c', quote: 'q' } }],
  ])('degrades to an empty list when claimSources is %s, keeping the analysis', async (_label, extra) => {
    respond({ ...good, ...extra })
    const r = await processBill({ ...html, claimSources: true }, env)
    expect(r.claimSources).toEqual([])
    expect(r.summary).toBe('Moves the filing deadline.')
    expect(r.tags).toEqual(['Voting'])
    expect(r.relevanceScore).toBe(6)
  })

  it('drops malformed items and keeps the well-formed ones', async () => {
    respond({ ...good, claimSources: [
      null,
      'a string',
      42,
      ['c', 'q'],
      {},
      { claim: 'no quote' },
      { quote: 'no claim' },
      { claim: 5, quote: 'q' },
      { claim: 'c', quote: 5 },
      { claim: 'c', quote: null },
      { claim: '', quote: 'q' },
      { claim: '   ', quote: 'q' },
      { claim: 'kept', quote: 'q' },
    ] })
    const r = await processBill({ ...html, claimSources: true }, env)
    expect(r.claimSources).toEqual([{ claim: 'kept', quote: 'q' }])
  })

  it('keeps an item whose quote is empty, so it can be counted as ungrounded later', async () => {
    respond({ ...good, claimSources: [{ claim: 'c', quote: '' }] })
    const r = await processBill({ ...html, claimSources: true }, env)
    expect(r.claimSources).toEqual([{ claim: 'c', quote: '' }])
  })

  it('ignores extra fields on an item', async () => {
    respond({ ...good, claimSources: [{ claim: 'c', quote: 'q', status: 'exact', note: 'x' }] })
    const r = await processBill({ ...html, claimSources: true }, env)
    expect(r.claimSources).toEqual([{ claim: 'c', quote: 'q' }])
  })

  it('returns null, not a list, when claim sources were not asked for', async () => {
    respond({ ...good, claimSources: [{ claim: 'c', quote: 'q' }] })
    const r = await processBill(html, env)
    expect(r.claimSources).toBeNull()
  })

  it('still fails an analysis whose summary is missing, claim sources or not', async () => {
    respond({ tags: [], relevanceScore: 5, claimSources: [{ claim: 'c', quote: 'q' }] })
    await expect(processBill({ ...html, claimSources: true }, env)).rejects.toThrow('Invalid response structure from AI provider')
  })
})

describe('a response cut off inside claim sources', () => {
  // claimSources is the last and only unbounded property, so a response that
  // hits the output limit is cut off there, after a complete summary.
  const cut = JSON.stringify({ ...good, claimSources: [{ claim: 'Moves the filing deadline.', quote: 'the deadline is moved' }] }).slice(0, -12)

  it('retries once without claim sources and returns the analysis with none', async () => {
    geminiGenerateMock
      .mockResolvedValueOnce({ text: cut })
      .mockResolvedValueOnce({ text: JSON.stringify(good) })
    const r = await processBill({ ...html, claimSources: true }, env)
    expect(geminiGenerateMock).toHaveBeenCalledTimes(2)
    const [first, second] = geminiGenerateMock.mock.calls.map(c => c[0])
    expect(first.config.responseSchema.properties).toHaveProperty('claimSources')
    expect(second.config.responseSchema.properties).not.toHaveProperty('claimSources')
    expect(second.contents).toEqual(first.contents)
    expect(second.config.serviceTier).toBe(first.config.serviceTier)
    expect(r).toMatchObject({ summary: 'Moves the filing deadline.', tags: ['Voting'], relevanceScore: 6, claimSources: null })
  })

  it('retries a PDF call the same way', async () => {
    geminiGenerateMock
      .mockResolvedValueOnce({ text: cut })
      .mockResolvedValueOnce({ text: JSON.stringify(good) })
    const r = await processBill({ ...pdf, claimSources: true }, env, 'priority')
    expect(geminiGenerateMock).toHaveBeenCalledTimes(2)
    expect(geminiGenerateMock.mock.calls[1][0].config.serviceTier).toBe('priority')
    expect(r.claimSources).toBeNull()
  })

  it('retries only once, failing when the second response does not parse either', async () => {
    geminiGenerateMock.mockResolvedValue({ text: cut })
    await expect(processBill({ ...html, claimSources: true }, env)).rejects.toThrow()
    expect(geminiGenerateMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry an unparseable response when claim sources were not asked for', async () => {
    geminiGenerateMock.mockResolvedValue({ text: 'not json' })
    await expect(processBill(html, env)).rejects.toThrow()
    expect(geminiGenerateMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a parseable response with an invalid structure', async () => {
    respond({ tags: [], relevanceScore: 5, claimSources: [] })
    await expect(processBill({ ...html, claimSources: true }, env)).rejects.toThrow('Invalid response structure from AI provider')
    expect(geminiGenerateMock).toHaveBeenCalledTimes(1)
  })
})
