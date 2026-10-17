import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills } from '../../src/db/schema'
import { app } from '../../src/index'
import { centralFetch } from '../../src/lib/centralFetch'

// Release 2's migration may rewrite a tenant's bills to `bill:<n>` before this
// worker is replaced (#305). Every call to central still names the bill by its
// legacy handle, since a central that predates release 1 answers 400 to `bill:<n>`
// or silently drops it from a batch. Every read of related bills and hearings
// finds a bill stored under either spelling.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() }) as unknown as Response
const asked = () => vi.mocked(centralFetch).mock.calls.map(c => [String(c[1]), c[2] as RequestInit | undefined] as const)

let member: string
let admin: string

beforeEach(async () => {
  await resetDb()
  await applyMigrations()
  vi.mocked(centralFetch).mockReset()
  member = `session=${await seedSession(await seedUser({ email: 'member@x.com', role: 'member' }))}`
  admin = `session=${await seedSession(await seedUser({ email: 'admin@x.com', role: 'admin' }))}`
})

describe('calls to central about a bill stored under the neutral handle', () => {
  it('proxies a text document by the legacy handle', async () => {
    const id = await seedBill({ billNumber: 'H 1', state: 'RI', externalId: 'bill:100' })
    vi.mocked(centralFetch).mockResolvedValue(new Response('<p>text</p>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    const res = await app.request(`/api/bills/${id}/text/999`, { headers: { Cookie: member } }, { ...env })
    expect(res.status).toBe(200)
    expect(asked().map(a => a[0])).toEqual(['/bills/legiscan:100/text/999'])
  })

  it('exports rich data asking central by legacy handles', async () => {
    await seedBill({ billNumber: 'H 2', state: 'RI', externalId: 'bill:998', matchType: 'keyword' })
    await seedBill({ billNumber: 'H 3', state: 'RI', externalId: 'legiscan:997', matchType: 'keyword' })
    vi.mocked(centralFetch).mockResolvedValue(json({ byId: {} }))
    const res = await app.request('/api/admin/export/rich', { headers: { Cookie: admin } }, { ...env })
    expect(res.status).toBe(200)
    const [path, init] = asked()[0]
    expect(path).toBe('/bills/rich-batch')
    expect((JSON.parse(init!.body as string).ids as string[]).sort()).toEqual(['legiscan:997', 'legiscan:998'])
  })

  it('tells central a keyword resync\'s match type updates by legacy handles', async () => {
    await getDb(env.DB).delete(associationConfig)
    await getDb(env.DB).insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const id = await seedBill({ externalId: 'bill:5', title: 'Vehicle Registration Bill', billNumber: 'HB 5', matchType: 'keyword' })
    vi.mocked(centralFetch).mockResolvedValue(json({}))
    const res = await app.request('/api/admin/keyword-resync', { method: 'POST', headers: { Cookie: admin } }, { ...env, BILL_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) } })
    expect(res.status).toBe(200)
    expect((await getDb(env.DB).select({ m: bills.matchType }).from(bills).where(eq(bills.id, id)).get())?.m).toBeNull()
    const update = asked().find(a => a[0].startsWith('/admin/update-bill-match-types/'))
    expect(JSON.parse(update![1]!.body as string).updates).toEqual([{ externalId: 'legiscan:5', matchType: null }])
  })
})

describe('related bills stored under either spelling', () => {
  it.each(['legiscan:102', 'bill:102'])('links a related bill the instance holds as %s', async (stored) => {
    const id = await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ', externalId: 'legiscan:101' })
    await seedBill({ id: 'a2', billNumber: 'A2', state: 'NJ', externalId: stored, session: '2026', sessionSlug: '2026-regular' })
    vi.mocked(centralFetch).mockResolvedValue(json({ relatedBills: [{ identifier: 'A2', sastBillId: 102, session: '1', relationType: 'same-as', kind: 'identical' }] }))
    const res = await app.request(`/api/bills/${id}`, { headers: { Cookie: member } }, { ...env })
    expect(res.status).toBe(200)
    const related = (await res.json() as any).relatedBillIds as Array<{ billNumber: string; route: { id: string } | null }>
    expect(related.map(r => [r.billNumber, r.route?.id ?? null])).toEqual([['A2', 'a2']])
  })

  it('links a related bill when the viewed bill is itself stored as a neutral handle', async () => {
    const id = await seedBill({ id: 'a1', billNumber: 'A1', state: 'NJ', externalId: 'bill:101' })
    await seedBill({ id: 'a2', billNumber: 'A2', state: 'NJ', externalId: 'bill:102' })
    vi.mocked(centralFetch).mockResolvedValue(json({ relatedBills: [{ identifier: 'A2', sastBillId: 102, session: '1', relationType: 'same-as', kind: 'identical' }] }))
    const res = await app.request(`/api/bills/${id}`, { headers: { Cookie: member } }, { ...env })
    const related = (await res.json() as any).relatedBillIds as Array<{ route: { id: string } | null }>
    expect(related[0].route?.id).toBe('a2')
    expect(asked().map(a => a[0])).toEqual(['/bills/legiscan:101'])
  })
})
