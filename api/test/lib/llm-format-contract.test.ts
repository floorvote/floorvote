import { describe, it, expect } from 'vitest'
import { composeSystemInstruction, SUMMARY_FORMAT_CONTRACT, DEFAULT_AI_CONTEXT } from '../../src/lib/llm'

describe('composeSystemInstruction', () => {
  it('appends the format contract to a provided ai_context', () => {
    const result = composeSystemInstruction('You are analyzing a bill for Example Org.')
    expect(result).toContain('You are analyzing a bill for Example Org.')
    expect(result).toContain(SUMMARY_FORMAT_CONTRACT)
  })

  it('falls back to DEFAULT_AI_CONTEXT when ai_context is null/undefined', () => {
    const result = composeSystemInstruction(undefined)
    expect(result).toContain(DEFAULT_AI_CONTEXT)
    expect(result).toContain(SUMMARY_FORMAT_CONTRACT)
  })

  it('format contract pins the "- " marker and forbids bad markers', () => {
    expect(SUMMARY_FORMAT_CONTRACT).toContain('- ')
    // must forbid the failure modes
    expect(SUMMARY_FORMAT_CONTRACT.toLowerCase()).toContain('bullet')   // it names the forbidden word
    expect(SUMMARY_FORMAT_CONTRACT).toContain('•')
    expect(SUMMARY_FORMAT_CONTRACT).toMatch(/HTML/i)
  })
})
