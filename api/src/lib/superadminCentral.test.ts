import { describe, it, expect, beforeEach } from 'vitest'
import { isSuperadminEmailViaCentral, _resetSuperadminAllowlistCache } from './superadminCentral'
import type { Env } from '../types'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function envWith(handler: (req: Request) => Response | Promise<Response>): Env {
  return { CENTRAL: { fetch: async (req: Request) => handler(req) } } as unknown as Env
}

describe('isSuperadminEmailViaCentral — cached hashed allowlist (D3)', () => {
  beforeEach(() => _resetSuperadminAllowlistCache())

  it('fetches the allowlist hashes and reports membership locally (normalized)', async () => {
    const hash = await sha256Hex('a@b.org')
    const env = envWith((req) => {
      expect(new URL(req.url).pathname).toBe('/api/admin/superadmin/emails')
      return new Response(JSON.stringify({ hashes: [hash] }), { status: 200 })
    })
    expect(await isSuperadminEmailViaCentral(env, 'a@b.org')).toBe(true)
    expect(await isSuperadminEmailViaCentral(env, 'A@B.org')).toBe(true)
    expect(await isSuperadminEmailViaCentral(env, 'other@b.org')).toBe(false)
  })

  it('fetches once, then serves a flood of distinct unknown emails from cache (D3)', async () => {
    let calls = 0
    const env = envWith(() => {
      calls++
      return new Response(JSON.stringify({ hashes: [] }), { status: 200 })
    })
    for (let i = 0; i < 25; i++) await isSuperadminEmailViaCentral(env, `rand${i}@x.com`)
    expect(calls).toBe(1) // not one central call per email
  })

  it('fails closed (false) on a central error with nothing cached', async () => {
    const env = envWith(() => new Response('x', { status: 500 }))
    expect(await isSuperadminEmailViaCentral(env, 'a@b.org')).toBe(false)
  })

  it('throttles refresh attempts during an outage — no per-call refetch storm', async () => {
    let calls = 0
    const env = envWith(() => {
      calls++
      return new Response('down', { status: 500 })
    })
    for (let i = 0; i < 10; i++) await isSuperadminEmailViaCentral(env, `x${i}@y.com`)
    expect(calls).toBe(1) // one attempt per TTL window, not one per email
  })
})
