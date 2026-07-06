import { describe, it, expect } from 'vitest'
import { checkRateLimit, type RateLimiter } from '../../../shared/rateLimit'

function fakeLimiter(result: boolean | (() => Promise<{ success: boolean }>)): RateLimiter {
  return {
    limit: typeof result === 'function'
      ? result
      : async () => ({ success: result }),
  }
}

describe('checkRateLimit', () => {
  it('fails open (allows) when no limiter is bound — dev / unconfigured', async () => {
    expect(await checkRateLimit(undefined, 'k')).toBe(true)
  })

  it('allows when the limiter reports success', async () => {
    expect(await checkRateLimit(fakeLimiter(true), 'k')).toBe(true)
  })

  it('blocks when the limiter reports the limit was exceeded', async () => {
    expect(await checkRateLimit(fakeLimiter(false), 'k')).toBe(false)
  })

  it('passes the key through to the binding', async () => {
    let seen = ''
    const limiter: RateLimiter = { limit: async ({ key }) => { seen = key; return { success: true } } }
    await checkRateLimit(limiter, 'magic-link:1.2.3.4')
    expect(seen).toBe('magic-link:1.2.3.4')
  })

  it('fails open (allows) if the limiter throws — never block auth on a limiter blip', async () => {
    const limiter = fakeLimiter(async () => { throw new Error('boom') })
    expect(await checkRateLimit(limiter, 'k')).toBe(true)
  })
})
