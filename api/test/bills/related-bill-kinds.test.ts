import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn(),
}))

// What central serves for a bill's related bills: raw label slug, and the kind
// its vocabulary maps the label to.
function centralServes(relatedBills: unknown[]) {
  vi.mocked(centralFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ relatedBills }),
  } as Response)
}

describe('GET /api/bills/:id: related bills', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    token = await seedSession(await seedUser({ email: 'member@x.com', role: 'member' }))
    vi.mocked(centralFetch).mockReset()
  })

  async function relatedOf(billId: string) {
    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return (await res.json() as any).relatedBillIds as Array<{ billNumber: string; type: string; kind: string; route: unknown }>
  }

  it('passes the kind central sends through, beside the label\'s slug', async () => {
    const id = await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:101', state: 'NJ' })
    centralServes([
      { identifier: 'S1713', sastBillId: 102, session: '1', relationType: 'same-as', kind: 'identical' },
      { identifier: 'HB4002', sastBillId: 103, session: '1', relationType: 'same-as', kind: 'package' },
      { identifier: 'S9', sastBillId: 104, session: '1', relationType: 'similar-to', kind: 'related' },
    ])
    const related = await relatedOf(id)
    expect(related.map(r => [r.billNumber, r.kind, r.type])).toEqual([
      ['S1713', 'identical', 'same-as'],
      ['HB4002', 'package', 'same-as'],
      ['S9', 'related', 'similar-to'],
    ])
  })

  it('serves a relationship as related when central sends no kind', async () => {
    const id = await seedBill({ id: 'a191', billNumber: 'A191', externalId: 'legiscan:111', state: 'NJ' })
    centralServes([{ identifier: 'S1', sastBillId: 112, session: '1', relationType: 'same-as' }])
    expect((await relatedOf(id))[0]).toMatchObject({ billNumber: 'S1', kind: 'related' })
  })

  it('serves a bill number from the stored list as related when central is unreachable', async () => {
    const id = await seedBill({ id: 'a192', billNumber: 'A192', externalId: 'legiscan:121', state: 'NJ', relatedBillIds: ['S2'] })
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    expect((await relatedOf(id))[0]).toMatchObject({ billNumber: 'S2', kind: 'related' })
  })

  it('links 60 related bills held under either spelling, past D1\'s 100-bind limit (#305)', async () => {
    const id = await seedBill({ id: 'a1', billNumber: 'A1', externalId: 'legiscan:101', state: 'NJ' })
    const numbers = Array.from({ length: 60 }, (_, i) => 5000 + i)
    for (const n of numbers) await seedBill({ id: `r${n}`, billNumber: `R${n}`, externalId: n % 2 ? `bill:${n}` : `legiscan:${n}`, state: 'NJ', session: '2026', sessionSlug: '2026-regular' })
    centralServes(numbers.map(n => ({ identifier: `R${n}`, sastBillId: n, session: '1', relationType: 'same-as', kind: 'related' })))
    const related = await relatedOf(id) as Array<{ billNumber: string; route: { id: string } | null }>
    expect(related).toHaveLength(60)
    expect(related.every(r => r.route?.id === `r${r.billNumber.slice(1)}`)).toBe(true)
  })
})
