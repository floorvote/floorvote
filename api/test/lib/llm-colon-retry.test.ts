import { describe, it, expect, vi, beforeEach } from 'vitest'

// A summary that stops on a colon: the model announces a list ("…for county
// clerks:") and ends its answer without writing it. The raw response really
// ends there, so the analysis asks once more rather than store half a summary.

const geminiGenerateMock = vi.hoisted(() => vi.fn())
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent: geminiGenerateMock } }
  }),
  ServiceTier: { FLEX: 'flex', STANDARD: 'standard', PRIORITY: 'priority', UNSPECIFIED: 'unspecified' },
}))

import { processBill } from '../../src/lib/llm'
import type { Env } from '../../src/types'

const env = { GEMINI_API_KEY: 'k', TENANT_ID: 't' } as unknown as Env
const bill = { billNumber: 'HB 1', title: 'T', text: 'Section 1. Text.', taxonomy: [{ name: 'Voting' }] }

const answer = (summary: string) => ({ text: JSON.stringify({ affectedCitations: [], summary, tags: ['Voting'], relevanceScore: 6 }) })
const STOPPED = 'Revises provisions relating to mail ballots for county clerks:'
const WHOLE = 'Revises provisions relating to mail ballots.\n- **Deadlines**: Moves the return deadline.\n- **Cure**: Extends the cure period.'

beforeEach(() => {
  geminiGenerateMock.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a summary that stops on a colon', () => {
  it('asks once more and keeps the whole answer', async () => {
    geminiGenerateMock.mockResolvedValueOnce(answer(STOPPED)).mockResolvedValueOnce(answer(WHOLE))
    const result = await processBill(bill, env)
    expect(geminiGenerateMock).toHaveBeenCalledTimes(2)
    expect(result.summary).toBe(WHOLE)
  })

  it('keeps the first answer when the second stops on a colon too, and asks only once more', async () => {
    geminiGenerateMock.mockResolvedValue(answer(STOPPED))
    const result = await processBill(bill, env)
    expect(geminiGenerateMock).toHaveBeenCalledTimes(2)
    expect(result.summary).toBe(STOPPED)
  })

  it('does not ask again when the colon introduces a list that is there', async () => {
    geminiGenerateMock.mockResolvedValue(answer('Revises mail ballot rules:\n- **Deadlines**: Moves the return deadline.'))
    await processBill(bill, env)
    expect(geminiGenerateMock).toHaveBeenCalledTimes(1)
  })

  it('does not ask again for a summary that ends as a sentence', async () => {
    geminiGenerateMock.mockResolvedValue(answer('Moves the filing deadline.'))
    await processBill(bill, env)
    expect(geminiGenerateMock).toHaveBeenCalledTimes(1)
  })
})
