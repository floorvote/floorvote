import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'
import { nextDraftNumber } from '../../src/lib/draftNumber'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn(),
}))

function mockSession(yearStart: number, yearEnd: number, sineDie: boolean) {
  vi.mocked(centralFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ yearStart, yearEnd, sineDie }),
  } as Response)
}

describe('nextDraftNumber (unit)', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('numbers each state independently, starting at D1', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values([
      { id: 'ut-1', billNumber: 'D1', title: 'One', state: 'UT', isDraft: true },
      { id: 'ut-2', billNumber: 'D2', title: 'Two', state: 'UT', isDraft: true },
      { id: 'co-1', billNumber: 'D1', title: 'Colorado One', state: 'CO', isDraft: true },
    ])
    // Deleting the eq(bills.state, state) clause would make this UT call see
    // all three D-numbered rows and return D3, same as CO's D2 — so a passing
    // pair of asserts here actually exercises the per-state filter.
    expect(await nextDraftNumber(db, 'UT')).toBe('D3')
    expect(await nextDraftNumber(db, 'CO')).toBe('D2')
  })

  it('returns D1 for a state with no existing drafts', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({ id: 'ut-1', billNumber: 'D1', title: 'One', state: 'UT', isDraft: true })
    expect(await nextDraftNumber(db, 'CO')).toBe('D1')
  })
})

describe('GET /api/bills/draft-defaults', () => {
  let adminId: string
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ email: 'admin@x.com', role: 'admin' })
    adminToken = await seedSession(adminId)
    const memberId = await seedUser({ email: 'member@x.com', role: 'member' })
    memberToken = await seedSession(memberId)
    vi.mocked(centralFetch).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // This also proves the route isn't shadowed by GET /bills/:id: a shadowed
  // request would hit the id lookup and come back 404 with a different body
  // shape, not 200 with { billNumber, year }.
  it('numbers the first draft D1 and uses the live session year', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T00:00:00Z'))
    mockSession(2025, 2026, false)
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    // tenantState is null because c.env.STATE is unset in the test worker —
    // the multi-state shape. It is the form's authoritative signal for whether
    // to show its State field.
    expect(await res.json()).toEqual({ billNumber: 'D1', year: 2025, tenantState: null })
  })

  it('advances past a sine die session', async () => {
    mockSession(2025, 2026, true)
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(await res.json()).toMatchObject({ year: 2027 })
  })

  it('clamps up to yearStart when the current year is earlier than the session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
    mockSession(2025, 2026, false)
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(await res.json()).toMatchObject({ year: 2025 })
  })

  it('clamps down to yearEnd when the current year is later than the session', async () => {
    // Advancing the clock this far would expire the session seeded in
    // beforeEach (its 30-day expiry was computed at real "now"), so re-seed
    // it after the jump.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    adminToken = await seedSession(adminId)
    mockSession(2025, 2026, false)
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(await res.json()).toMatchObject({ year: 2026 })
  })

  it('increments the number past existing drafts', async () => {
    mockSession(2025, 2026, false)
    // c.env.STATE is unset in the test worker (see vitest.config.mts — several
    // configApi tests rely on that too), so the route computes state === ''.
    // Seed drafts with the matching state so this exercises the live route;
    // the per-state filter itself is covered directly above, against real
    // state values, via nextDraftNumber().
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

  it('falls back to the tenant\'s own newest year when central returns a non-ok response', async () => {
    vi.mocked(centralFetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response)
    const db = getDb(env.DB)
    await db.insert(bills).values({ id: 'f', billNumber: 'HB1', title: 'Filed', state: '', yearStart: 2024, yearEnd: 2024 })
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ year: 2024 })
  })

  it('falls back to the current year when central is unreachable and the tenant has no filed bills', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2028-03-15T00:00:00Z'))
    adminToken = await seedSession(adminId) // re-seed: see comment above
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ year: 2028 })
  })

  it('numbers within the ?state= bucket, independently of the stateless bucket', async () => {
    // The multi-state case: c.env.STATE is '' in the test worker, so without
    // ?state= the route prefills from the '' bucket. The admin has picked TX in
    // the form, so the number must come from TX's own bucket — otherwise the
    // second TX draft is handed a number that POST /bills/draft 409s on.
    mockSession(2025, 2026, false)
    const db = getDb(env.DB)
    await db.insert(bills).values([
      { id: 'legacy-1', billNumber: 'D1', title: 'Legacy one', state: '', isDraft: true },
      { id: 'legacy-2', billNumber: 'D2', title: 'Legacy two', state: '', isDraft: true },
      { id: 'legacy-3', billNumber: 'D3', title: 'Legacy three', state: '', isDraft: true },
      { id: 'tx-1', billNumber: 'D1', title: 'Texas one', state: 'TX', isDraft: true },
    ])
    const res = await SELF.fetch('https://x/api/bills/draft-defaults?state=TX', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ billNumber: 'D2' })

    // Same request without the param still sees the '' bucket — proving the
    // two are genuinely separate and that D2 above isn't just D4 by luck.
    const stateless = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(await stateless.json()).toMatchObject({ billNumber: 'D4' })
  })

  it('lower-cases and trims ?state= into the canonical bucket', async () => {
    mockSession(2025, 2026, false)
    const db = getDb(env.DB)
    await db.insert(bills).values({ id: 'tx-1', billNumber: 'D7', title: 'Texas', state: 'TX', isDraft: true })
    const res = await SELF.fetch('https://x/api/bills/draft-defaults?state=%20tx%20', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(await res.json()).toMatchObject({ billNumber: 'D8' })
  })

  it('asks central for the session of the state the admin picked', async () => {
    mockSession(2025, 2026, false)
    await SELF.fetch('https://x/api/bills/draft-defaults?state=TX', {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(vi.mocked(centralFetch)).toHaveBeenCalledWith(
      expect.anything(),
      '/tenants/current-session/TX',
    )
  })

  it('rejects a non-admin with 403', async () => {
    const res = await SELF.fetch('https://x/api/bills/draft-defaults', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(403)
  })
})
