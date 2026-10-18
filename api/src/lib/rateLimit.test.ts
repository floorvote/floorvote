import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkRateLimit, type RateLimiter } from '../../../shared/rateLimit'

function fakeLimiter(result: boolean | (() => Promise<{ success: boolean }>)): RateLimiter {
  return {
    limit: typeof result === 'function'
      ? result
      : async () => ({ success: result }),
  }
}

describe('checkRateLimit', () => {
  afterEach(() => { vi.restoreAllMocks() })

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

  it('logs a warning naming the key and the error when it fails open on a throw, so a broken binding shows in the logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const limiter = fakeLimiter(async () => { throw new Error('boom') })
    expect(await checkRateLimit(limiter, 'mute-link:1.2.3.4')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    const logged = String(warn.mock.calls[0].join(' '))
    expect(logged).toMatch(/rate limiter.*mute-link.*boom/i)
    expect(logged).not.toContain('1.2.3.4')
  })

  it('logs nothing when the limiter answers, either way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await checkRateLimit(fakeLimiter(true), 'k')
    await checkRateLimit(fakeLimiter(false), 'k')
    expect(warn).not.toHaveBeenCalled()
  })
})
