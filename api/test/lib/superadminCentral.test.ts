import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as centralFetchMod from '../../src/lib/centralFetch'
import { isSuperadminEmailViaCentral, _resetSuperadminAllowlistCache } from '../../src/lib/superadminCentral'

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

  it('treats an empty allowlist as nobody is a superadmin', async () => {
    vi.spyOn(centralFetchMod, 'centralFetch').mockResolvedValue(
      new Response(JSON.stringify({ hashes: [] }), { status: 200 }),
    )
    expect(await isSuperadminEmailViaCentral(env, 'admin@x.com')).toBe(false)
  })
})
