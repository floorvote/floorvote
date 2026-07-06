import { describe, it, expect, vi, afterEach } from 'vitest'
import { verifyTurnstile } from '../../../shared/turnstile'

afterEach(() => vi.restoreAllMocks())

describe('verifyTurnstile (stub: fail-open unset, fail-closed set)', () => {
  it('allows (fail-open) when no secret is configured — dev / pre-operator-setup', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await verifyTurnstile(undefined, 'anything')).toBe(true)
    expect(await verifyTurnstile('', 'anything')).toBe(true)
    // never calls siteverify when unconfigured
    expect(spy).not.toHaveBeenCalled()
  })

  it('fails closed when configured but the token is missing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await verifyTurnstile('secret', undefined)).toBe(false)
    expect(await verifyTurnstile('secret', '')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('calls siteverify and returns true on a successful verification', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    )
    expect(await verifyTurnstile('secret', 'tok', '1.2.3.4')).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('challenges.cloudflare.com/turnstile/v0/siteverify')
    expect((init as RequestInit).method).toBe('POST')
  })

  it('returns false when siteverify reports failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 }),
    )
    expect(await verifyTurnstile('secret', 'tok')).toBe(false)
  })

  it('fails closed when siteverify throws (configured = fail-closed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'))
    expect(await verifyTurnstile('secret', 'tok')).toBe(false)
  })

  it('fails closed on a non-200 siteverify response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    expect(await verifyTurnstile('secret', 'tok')).toBe(false)
  })
})
