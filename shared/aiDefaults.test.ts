import { describe, it, expect } from 'vitest'
import {
  AI_CONTEXT_TEMPLATE,
  RELEVANCE_QUESTION_TEMPLATE,
  ASSOCIATION_NAME_PLACEHOLDER,
  buildDefaultAiContext,
  buildDefaultRelevanceQuestion,
  isAiConfigDefault,
} from './aiDefaults'

describe('templates', () => {
  it('carry a single {name} slot', () => {
    expect(AI_CONTEXT_TEMPLATE).toContain('{name}')
    expect(RELEVANCE_QUESTION_TEMPLATE).toContain('{name}')
  })

  it('contain no bracketed placeholder markers — the default must be runnable as-is', () => {
    // The retired design shipped "[FILL THIS IN…]" inside the prompt. Guard against
    // anyone reintroducing unrunnable text into what the model actually receives.
    expect(AI_CONTEXT_TEMPLATE).not.toMatch(/\[[A-Z ]{4,}/)
    expect(AI_CONTEXT_TEMPLATE).not.toMatch(/FILL THIS IN/i)
  })

  it('use real newlines, not escaped ones', () => {
    expect(AI_CONTEXT_TEMPLATE).toContain('\n\n')
    expect(AI_CONTEXT_TEMPLATE).not.toContain('\\n')
  })
})

describe('buildDefaultAiContext', () => {
  it('interpolates the association name', () => {
    const out = buildDefaultAiContext('Texas Association of Election Officials')
    expect(out).toContain('You are analyzing a bill for Texas Association of Election Officials.')
    expect(out).not.toContain('{name}')
  })

  it('falls back to the placeholder name when given a blank name', () => {
    expect(buildDefaultAiContext('')).toContain(ASSOCIATION_NAME_PLACEHOLDER)
    expect(buildDefaultAiContext('   ')).toContain(ASSOCIATION_NAME_PLACEHOLDER)
  })

  it('inserts a name containing $-based replacement patterns verbatim', () => {
    // String.replace treats $&, $$, $`, $', $<n> specially when the replacement
    // is a string. buildDefaultAiContext must use a function replacer so a name
    // like this passes through untouched instead of being corrupted.
    const name = 'Smith & Co. ($$)'
    const out = buildDefaultAiContext(name)
    expect(out).toContain(`You are analyzing a bill for ${name}.`)
  })
})

describe('buildDefaultRelevanceQuestion', () => {
  it('interpolates the association name', () => {
    expect(buildDefaultRelevanceQuestion('Prairie Policy Alliance'))
      .toBe("Rate this bill's relevance to Prairie Policy Alliance's legislative priorities.")
  })
})

describe('isAiConfigDefault', () => {
  it('treats absent, empty, and whitespace-only as default', () => {
    expect(isAiConfigDefault(undefined)).toBe(true)
    expect(isAiConfigDefault(null)).toBe(true)
    expect(isAiConfigDefault('')).toBe(true)
    expect(isAiConfigDefault('   \n  ')).toBe(true)
  })

  it('treats admin-written prose as customized', () => {
    expect(isAiConfigDefault('You are analyzing bills for county clerks.')).toBe(false)
  })
})
