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
    geminiGenerateMock.mockResolvedValueOnce({
      text: JSON.stringify({ summary: 'PDF.', tags: [], relevanceScore: 5 }),
    })
    await processBill(
      { billNumber: 'HB 7', title: 'T', text: 't', pdfBase64: btoa('%PDF fake'), taxonomy: [] },
      makeEnv(),
    )
    const model = geminiGenerateMock.mock.calls[0][0].model
    expect(model).toBe('gemini-2.5-flash')
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
