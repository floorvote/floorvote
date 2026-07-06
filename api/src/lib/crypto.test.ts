import { describe, it, expect } from 'vitest'
import { secretsMatch } from './crypto'

describe('secretsMatch', () => {
  it('returns true for identical secrets', async () => {
    expect(await secretsMatch('s3cret-value', 's3cret-value')).toBe(true)
  })

  it('returns false for differing secrets of equal length', async () => {
    expect(await secretsMatch('s3cret-valuX', 's3cret-value')).toBe(false)
  })

  it('returns false for secrets of differing length (no throw)', async () => {
    expect(await secretsMatch('short', 'a-much-longer-secret')).toBe(false)
  })

  it('returns false when the provided value is missing', async () => {
    expect(await secretsMatch(undefined, 'expected')).toBe(false)
    expect(await secretsMatch(null, 'expected')).toBe(false)
    expect(await secretsMatch('', 'expected')).toBe(false)
  })
})
