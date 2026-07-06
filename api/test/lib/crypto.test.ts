import { describe, it, expect } from 'vitest'
import { generateToken, hashToken } from '../../src/lib/crypto'

describe('generateToken', () => {
  it('returns a 64-character hex string', async () => {
    const token = await generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns different tokens on each call', async () => {
    const a = await generateToken()
    const b = await generateToken()
    expect(a).not.toBe(b)
  })
})

describe('hashToken', () => {
  it('returns a 64-character hex string', async () => {
    const hash = await hashToken('abc')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic — same input yields same hash', async () => {
    const h1 = await hashToken('abc')
    const h2 = await hashToken('abc')
    expect(h1).toBe(h2)
  })

  it('different inputs yield different hashes', async () => {
    const h1 = await hashToken('abc')
    const h2 = await hashToken('xyz')
    expect(h1).not.toBe(h2)
  })
})
