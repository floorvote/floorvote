import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn(),
}))

describe('GET /api/bills/draft-defaults', () => {
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
    adminToken = await seedSession(adminId)
    const memberId = await seedUser({ email: 'member@x.com', role: 'member' })
    memberToken = await seedSession(memberId)
    vi.mocked(centralFetch).mockReset()
  })

  it('numbers the first draft D1 and uses the live session year', async () => {
    vi.mocked(centralFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ yearStart: 2025, yearEnd: 2026, sineDie: false }),
    } as Response)
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ billNumber: 'D1', year: new Date().getUTCFullYear() })
  })

  it('advances past a sine die session', async () => {
    vi.mocked(centralFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ yearStart: 2025, yearEnd: 2026, sineDie: true }),
    } as Response)
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(await res.json()).toMatchObject({ year: 2027 })
  })

  it('increments the number past existing drafts', async () => {
    vi.mocked(centralFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ yearStart: 2025, yearEnd: 2026, sineDie: false }),
    } as Response)
    // c.env.STATE is unset in the test worker (see vitest.config.mts — several
    // configApi tests rely on that too), so the route computes state === ''.
    // Seed drafts with the matching state rather than 'UT' so this test
    // actually exercises the per-state filter instead of accidentally passing.
    const db = getDb(env.DB)
    await db.insert(bills).values([
      { id: 'a', billNumber: 'D1', title: 'One', state: '', isDraft: true },
      { id: 'b', billNumber: 'D2', title: 'Two', state: '', isDraft: true },
    ])
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(await res.json()).toMatchObject({ billNumber: 'D3' })
  })

  it('falls back to the tenant\'s own newest year when central is unreachable', async () => {
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    const db = getDb(env.DB)
    await db.insert(bills).values({ id: 'f', billNumber: 'HB1', title: 'Filed', state: '', yearStart: 2026, yearEnd: 2026 })
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ year: 2026 })
  })

  it('rejects a non-admin with 403', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(403)
  })

  it('is not shadowed by GET /bills/:id', async () => {
    vi.mocked(centralFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ yearStart: 2025, yearEnd: 2026, sineDie: false }),
    } as Response)
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ billNumber: string; year: number }>()
    expect(body).toHaveProperty('billNumber')
    expect(body).toHaveProperty('year')
  })
})
