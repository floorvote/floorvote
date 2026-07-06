import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index-legiscan'
import { isTenantSurfaceAllowed } from '../../src/lib/tenantSurface'

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'admin-secret', SUPERADMIN_EMAILS: 'a@x.com, B@x.com' }

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('GET /api/admin/superadmin/emails (D3)', () => {
  it('returns SHA-256 hashes of the normalized allowlist', async () => {
    const res = await app.fetch(
      new Request('http://central/api/admin/superadmin/emails', { headers: { 'x-admin-secret': 'admin-secret' } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { hashes: string[] }
    const expected = [await sha256Hex('a@x.com'), await sha256Hex('b@x.com')].sort()
    expect([...body.hashes].sort()).toEqual(expected)
  })

  it('does not leak plaintext emails', async () => {
    const res = await app.fetch(
      new Request('http://central/api/admin/superadmin/emails', { headers: { 'x-admin-secret': 'admin-secret' } }),
      TEST_ENV,
    )
    const text = await res.text()
    expect(text).not.toContain('a@x.com')
    expect(text).not.toContain('b@x.com')
  })

  it('requires the admin secret', async () => {
    const res = await app.fetch(new Request('http://central/api/admin/superadmin/emails'), TEST_ENV)
    expect(res.status).toBe(401)
  })

  it('is on the tenant-reachable surface allowlist', () => {
    expect(isTenantSurfaceAllowed('GET', '/api/admin/superadmin/emails')).toBe(true)
  })
})
