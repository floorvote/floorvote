import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Gemini mock ---
const geminiGenerateMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    text: JSON.stringify({
      summary: 'Gemini summary.',
      tags: ['voting'],
      relevanceScore: 7,
    }),
  }),
)
const GoogleGenAIMock = vi.hoisted(() =>
  vi.fn().mockImplementation(function () {
    return { models: { generateContent: geminiGenerateMock } }
  }),
)
vi.mock('@google/genai', () => ({
  GoogleGenAI: GoogleGenAIMock,
  ServiceTier: {
    FLEX: 'flex',
    STANDARD: 'standard',
    PRIORITY: 'priority',
    UNSPECIFIED: 'unspecified',
  },
}))

import { processBill } from '../../src/lib/llm'
import type { Env } from '../../src/types'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    RESEND_API_KEY: 'test',
    GEMINI_API_KEY: 'test-gemini-key',
    APP_URL: 'http://localhost',
    TENANT_ID: 'test-tenant',
    CENTRAL_API_URL: 'https://central.test',
    ...overrides,
  } as Env
}

describe('processBill — Gemini provider (default)', () => {
  beforeEach(() => {
    geminiGenerateMock.mockClear()
    GoogleGenAIMock.mockClear()
    geminiGenerateMock.mockResolvedValue({
      text: JSON.stringify({ summary: 'Gemini summary.', tags: ['voting'], relevanceScore: 7 }),
    })
  })

  it('returns parsed summary, tags, and relevanceScore', async () => {
    const result = await processBill(
      { billNumber: 'HB 1', title: 'Election Act', text: 'Full text.', taxonomy: [{ name: 'voting' }] },
      makeEnv(),
    )
    expect(result.summary).toBe('Gemini summary.')
    expect(result.tags).toEqual(['voting'])
    expect(result.relevanceScore).toBe(7)
  })

  it('sends inlineData PDF block when pdfBase64 is provided', async () => {
    geminiGenerateMock.mockResolvedValueOnce({
      text: JSON.stringify({ summary: 'PDF bill.', tags: [], relevanceScore: 5 }),
    })
    await processBill(
      { billNumber: 'HB 2', title: 'PDF Bill', text: 'desc', pdfBase64: btoa('%PDF fake'), taxonomy: [] },
      makeEnv(),
    )
    const call = geminiGenerateMock.mock.calls[0][0]
    const parts = call.contents[0].parts
    expect(parts[0].inlineData.mimeType).toBe('application/pdf')
    expect(parts[0].inlineData.data).toBe(btoa('%PDF fake'))
    expect(parts[1].text).toBeDefined()
  })

  it('clamps relevanceScore above 10 down to 10', async () => {
    geminiGenerateMock.mockResolvedValueOnce({
      text: JSON.stringify({ summary: 'x', tags: [], relevanceScore: 99 }),
    })
    const result = await processBill(
      { billNumber: 'HB 3', title: 'T', text: 't', taxonomy: [] },
      makeEnv(),
    )
    expect(result.relevanceScore).toBe(10)
  })

  it('clamps relevanceScore below 1 up to 1', async () => {
    geminiGenerateMock.mockResolvedValueOnce({
      text: JSON.stringify({ summary: 'x', tags: [], relevanceScore: -5 }),
    })
    const result = await processBill(
      { billNumber: 'HB 4', title: 'T', text: 't', taxonomy: [] },
      makeEnv(),
    )
    expect(result.relevanceScore).toBe(1)
  })

  it('throws when Gemini returns malformed JSON', async () => {
    geminiGenerateMock.mockResolvedValueOnce({ text: 'not json' })
    await expect(
      processBill({ billNumber: 'HB 5', title: 'T', text: 't', taxonomy: [] }, makeEnv()),
    ).rejects.toThrow()
  })

  it('throws when response structure is invalid', async () => {
    geminiGenerateMock.mockResolvedValueOnce({ text: JSON.stringify({ wrong: 'shape' }) })
    await expect(
      processBill({ billNumber: 'HB 6', title: 'T', text: 't', taxonomy: [] }, makeEnv()),
    ).rejects.toThrow('Invalid response structure from AI provider')
  })

  it('throws when Gemini returns an empty response', async () => {
    geminiGenerateMock.mockResolvedValueOnce({ text: undefined })
    await expect(
      processBill({ billNumber: 'HB 7a', title: 'T', text: 't', taxonomy: [] }, makeEnv()),
    ).rejects.toThrow('Gemini returned an empty response')
  })

  it('uses one model for both text and PDF (no model switching)', async () => {
    // Asserts the two paths agree, not which model they agree on — the model is
    // a configurable default now, and pinning its name here would make every
    // future upgrade fail a test about something else.
    await processBill(
      { billNumber: 'HB 7', title: 'T', text: 't', taxonomy: [] },
      makeEnv(),
    )
    await processBill(
      { billNumber: 'HB 7', title: 'T', text: 't', pdfBase64: btoa('%PDF fake'), taxonomy: [] },
      makeEnv(),
    )
    const [textCall, pdfCall] = geminiGenerateMock.mock.calls
    expect(pdfCall[0].model).toBe(textCall[0].model)
  })

  it('constrains tags to the taxonomy with a responseSchema enum', async () => {
    await processBill(
      {
        billNumber: 'HB 10', title: 'T', text: 't',
        taxonomy: [{ name: 'Elections & Voting' }, { name: 'Local Government', description: 'county and municipal' }],
      },
      makeEnv(),
    )
    const schema = geminiGenerateMock.mock.calls[0][0].config.responseSchema
    expect(schema.properties.tags.items).toEqual({
      type: 'string', format: 'enum', enum: ['Elections & Voting', 'Local Government'],
    })
  })

  it('falls back to an unconstrained tag schema when the taxonomy is empty', async () => {
    await processBill(
      { billNumber: 'HB 11', title: 'T', text: 't', taxonomy: [] },
      makeEnv(),
    )
    const schema = geminiGenerateMock.mock.calls[0][0].config.responseSchema
    expect(schema.properties.tags.items).toEqual({ type: 'string' })
  })
})

describe('provider factory', () => {
  it('throws with a clear message when AI_GATEWAY_ENABLED=true but gateway vars are missing', async () => {
    const promise = Promise.resolve().then(() =>
      processBill(
        { billNumber: 'HB 20', title: 'T', text: 't', taxonomy: [] },
        makeEnv({ AI_GATEWAY_ENABLED: 'true', CF_ACCOUNT_ID: undefined, CF_AIG_GATEWAY: undefined, CF_AIG_TOKEN: undefined }),
      )
    )
    await expect(promise).rejects.toThrow('AI_GATEWAY_ENABLED is true but CF_ACCOUNT_ID, CF_AIG_GATEWAY, or CF_AIG_TOKEN is missing')
  })
})

describe('analysis model and thinking budget are per-environment', () => {
  beforeEach(() => {
    geminiGenerateMock.mockClear()
    geminiGenerateMock.mockResolvedValue({
      text: JSON.stringify({ affectedCitations: [], summary: 's', tags: [], relevanceScore: 5 }),
    })
  })

  const call = (env: Env) => processBill(
    { billNumber: 'HB 1', title: 'T', text: 'x', taxonomy: [{ name: 'voting' }] },
    env,
  )
  const lastCall = () => geminiGenerateMock.mock.calls[0][0]

  it('defaults to the incumbent configuration, so a deploy changes no tenant', async () => {
    await call(makeEnv())
    expect(lastCall().model).toBe('gemini-2.5-flash')
    expect(lastCall().config.thinkingConfig.thinkingBudget).toBe(0)
  })

  it('opts a single environment into a newer model and thinking', async () => {
    await call(makeEnv({ GEMINI_MODEL: 'gemini-3.5-flash', GEMINI_THINKING_BUDGET: '-1' }))
    expect(lastCall().model).toBe('gemini-3.5-flash')
    expect(lastCall().config.thinkingConfig.thinkingBudget).toBe(-1)
  })

  it('honours a per-environment model override', async () => {
    await call(makeEnv({ GEMINI_MODEL: 'gemini-3.8-flash' }))
    expect(lastCall().model).toBe('gemini-3.8-flash')
  })

  it('honours a per-environment thinking budget', async () => {
    await call(makeEnv({ GEMINI_THINKING_BUDGET: '512' }))
    expect(lastCall().config.thinkingConfig.thinkingBudget).toBe(512)
  })

  it('falls back to the defaults when overrides are blank or unparseable', async () => {
    await call(makeEnv({ GEMINI_MODEL: '   ', GEMINI_THINKING_BUDGET: 'lots' }))
    expect(lastCall().model).toBe('gemini-2.5-flash')
    expect(lastCall().config.thinkingConfig.thinkingBudget).toBe(0)
  })
})

describe('affectedCitations extraction', () => {
  beforeEach(() => { geminiGenerateMock.mockClear() })

  const run = async (payload: Record<string, unknown>) => {
    geminiGenerateMock.mockResolvedValue({ text: JSON.stringify(payload) })
    return processBill(
      { billNumber: 'HB 1', title: 'T', text: 'x', taxonomy: [{ name: 'voting' }] },
      makeEnv(),
    )
  }

  it('returns the citations the model reported, verbatim', async () => {
    const r = await run({ affectedCitations: ['17-70-401', '10-3-301'], summary: 's', tags: [], relevanceScore: 5 })
    expect(r.affectedCitations).toEqual(['17-70-401', '10-3-301'])
  })

  it('is generated before the fields that may depend on it', async () => {
    await run({ affectedCitations: [], summary: 's', tags: [], relevanceScore: 5 })
    const schema = geminiGenerateMock.mock.calls[0][0].config.responseSchema
    expect(schema.propertyOrdering[0]).toBe('affectedCitations')
    expect(schema.required).toContain('affectedCitations')
  })

  it('degrades to empty rather than discarding an otherwise good analysis', async () => {
    const r = await run({ affectedCitations: 'not-an-array', summary: 's', tags: ['voting'], relevanceScore: 6 })
    expect(r.affectedCitations).toEqual([])
    expect(r.summary).toBe('s')
    expect(r.relevanceScore).toBe(6)
  })

  it('drops blank and non-string entries', async () => {
    const r = await run({ affectedCitations: ['17-70-401', '', '   ', 42, null], summary: 's', tags: [], relevanceScore: 5 })
    expect(r.affectedCitations).toEqual(['17-70-401'])
  })
})
