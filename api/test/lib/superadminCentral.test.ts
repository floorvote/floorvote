import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as centralFetchMod from '../../src/lib/centralFetch'
import { isSuperadminEmailViaCentral, superadminEmailStatus, _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const env = {} as never

describe('isSuperadminEmailViaCentral — cached allowlist (D3)', () => {
  beforeEach(() => {
    _resetSuperadminAllowlistCache()
    vi.restoreAllMocks()
  })

  it('fetches the allowlist once and serves all subsequent checks from cache', async () => {
    const hash = await sha256Hex('admin@x.com')
    const spy = vi
      .spyOn(centralFetchMod, 'centralFetch')
      .mockResolvedValue(new Response(JSON.stringify({ hashes: [hash] }), { status: 200 }))

    expect(await isSuperadminEmailViaCentral(env, 'admin@x.com')).toBe(true)
    expect(await isSuperadminEmailViaCentral(env, 'ADMIN@x.com')).toBe(true) // normalized
    expect(await isSuperadminEmailViaCentral(env, 'random1@x.com')).toBe(false)
    expect(await isSuperadminEmailViaCentral(env, 'random2@x.com')).toBe(false)
    // One fetch for the whole flood — not one per email (the D3 fix).
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('fails closed (false) when central is unreachable and nothing is cached', async () => {
    vi.spyOn(centralFetchMod, 'centralFetch').mockRejectedValue(new Error('central down'))
    expect(await isSuperadminEmailViaCentral(env, 'admin@x.com')).toBe(false)
  })

  it('answers a check that arrives while the first fetch is still in flight', async () => {
    // A cold isolate takes a page load's requests concurrently. Only the first
    // fetches; the rest must wait for that answer, not read the empty cache.
    const hash = await sha256Hex('admin@x.com')
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.spyOn(centralFetchMod, 'centralFetch').mockImplementation(async () => {
      await gate
      return new Response(JSON.stringify({ hashes: [hash] }), { status: 200 })
    })

    const first = isSuperadminEmailViaCentral(env, 'admin@x.com')
    const second = isSuperadminEmailViaCentral(env, 'admin@x.com')
    release()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })

  it('stops waiting on a hung fetch after the cap and answers unknown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      vi.spyOn(centralFetchMod, 'centralFetch').mockImplementation(() => new Promise<Response>(() => {}))

      void superadminEmailStatus(env, 'admin@x.com') // starts the fetch, which never settles
      let answer: string | undefined
      const waiter = superadminEmailStatus(env, 'admin@x.com').then((a) => { answer = a })

      await vi.advanceTimersByTimeAsync(1999)
      expect(answer).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await waiter
      expect(answer).toBe('unknown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an empty allowlist as nobody is a superadmin', async () => {
    vi.spyOn(centralFetchMod, 'centralFetch').mockResolvedValue(
      new Response(JSON.stringify({ hashes: [] }), { status: 200 }),
    )
    expect(await isSuperadminEmailViaCentral(env, 'admin@x.com')).toBe(false)
  })
})
