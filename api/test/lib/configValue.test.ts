import { describe, it, expect } from 'vitest'
import { readConfigString } from '../../src/lib/configValue'

describe('readConfigString', () => {
  it('decodes a JSON-encoded string, restoring real newlines', () => {
    const stored = JSON.stringify('You are analyzing a bill.\n\nSecond paragraph.')
    const out = readConfigString({ value: stored })
    expect(out).toBe('You are analyzing a bill.\n\nSecond paragraph.')
    expect(out).not.toContain('\\n')
    expect(out?.startsWith('"')).toBe(false)
  })

  it('passes through a bare legacy string that is not valid JSON', () => {
    expect(readConfigString({ value: 'plain legacy text' })).toBe('plain legacy text')
  })

  it('returns undefined for a missing row', () => {
    expect(readConfigString(undefined)).toBeUndefined()
    expect(readConfigString(null)).toBeUndefined()
  })

  it('returns undefined when the decoded value is not a string', () => {
    expect(readConfigString({ value: JSON.stringify(['a', 'b']) })).toBeUndefined()
    expect(readConfigString({ value: JSON.stringify(42) })).toBeUndefined()
  })
})
