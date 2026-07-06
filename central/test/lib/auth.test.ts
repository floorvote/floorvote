import { describe, it, expect } from 'vitest'
import { secretsMatch } from '../../src/lib/auth'

// secretsMatch is the admin-secret gate on every central admin/tenant/bills
// route. A regression that made it return true for a wrong secret would open
// the entire central API silently, so its branches are worth pinning down.
describe('secretsMatch', () => {
  it('returns true for two identical secrets', async () => {
    expect(await secretsMatch('s3cr3t-value', 's3cr3t-value')).toBe(true)
  })

  it('returns false when the secrets differ', async () => {
    expect(await secretsMatch('wrong-secret', 's3cr3t-value')).toBe(false)
  })

  it('returns false when the candidate differs only in case', async () => {
    expect(await secretsMatch('Secret', 'secret')).toBe(false)
  })

  it('returns false when the candidate is a prefix of the expected', async () => {
    expect(await secretsMatch('secret', 'secret-extra')).toBe(false)
  })

  it('returns false for a null candidate', async () => {
    expect(await secretsMatch(null, 'secret')).toBe(false)
  })

  it('returns false for an undefined candidate', async () => {
    expect(await secretsMatch(undefined, 'secret')).toBe(false)
  })

  it('returns false for an empty candidate (guard rejects falsy input)', async () => {
    expect(await secretsMatch('', 'secret')).toBe(false)
  })

  // L2: an empty/unset EXPECTED secret must never match, so a misconfigured
  // worker (ADMIN_SECRET unset) fails closed rather than authenticating anyone.
  it('returns false when the expected secret is empty, even for an empty candidate', async () => {
    expect(await secretsMatch('', '')).toBe(false)
    expect(await secretsMatch('anything', '')).toBe(false)
  })
})
