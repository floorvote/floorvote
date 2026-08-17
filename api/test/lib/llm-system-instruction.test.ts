import { describe, it, expect } from 'vitest'
import { composeSystemInstruction, DEFAULT_AI_CONTEXT } from '../../src/lib/llm'

describe('composeSystemInstruction', () => {
  it('falls back to the default for undefined', () => {
    expect(composeSystemInstruction(undefined)).toContain(DEFAULT_AI_CONTEXT)
  })

  it('falls back to the default for empty string', () => {
    // Regression: `??` does not catch '' , and blank is the normal state now that
    // nothing is written to association_config at provisioning.
    expect(composeSystemInstruction('')).toContain(DEFAULT_AI_CONTEXT)
  })

  it('falls back to the default for whitespace-only', () => {
    expect(composeSystemInstruction('   \n ')).toContain(DEFAULT_AI_CONTEXT)
  })

  it('uses tenant context when present', () => {
    expect(composeSystemInstruction('Analyze for county clerks.')).toContain('Analyze for county clerks.')
  })
})
