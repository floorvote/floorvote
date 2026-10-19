import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, billCommittees, bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'
import { registerWithCentral } from '../../src/cron/sync'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))

vi.mock('../../src/cron/sync', async () => {
  const actual = await vi.importActual<typeof import('../../src/cron/sync')>('../../src/cron/sync')
  return { ...actual, registerWithCentral: vi.fn().mockResolvedValue(true), realRegisterWithCentral: actual.registerWithCentral }
})

// The admin routes behind the Bill committees card (#471): the committees with their sizes, the running total for
// a set of picks, saving the picks (sent to central at registration, as keywords are), and the keyword re-run that
// a save starts, which treats a bill in a picked committee as a match.

let adminCookie: string
let memberCookie: string

async function refer(billId: string, committeeId: string, name: string) {
  await getDb(env.DB).insert(billCommittees).values({ billId, committeeId, state: 'RI', name, chamber: 'S', isCurrent: false })
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  adminCookie = `session=${await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))}`
  memberCookie = `session=${await seedSession(await seedUser({ role: 'member', email: 'member@example.com' }))}`
})

describe('GET /admin/bill-committees', () => {
  it("lists each committee's size, its state's bill count, the saved picks, and their total", async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'bill_committees', value: JSON.stringify(['101']) })
    const a = await seedBill({ externalId: 'legiscan:1', title: 'Court Fees', matchType: null })
    await seedBill({ externalId: 'legiscan:2', title: 'Parks', matchType: null })
    await refer(a, '101', 'Judiciary')

    const res = await app.request('/api/admin/bill-committees', { headers: { Cookie: adminCookie } }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      counts: { 101: 1 },
      info: { 101: { name: 'Judiciary', state: 'RI', chamber: 'S' } },
      stateTotals: { RI: 2 },
      selected: ['101'],
      summary: { total: 2, analyzed: 1, added: 1 },
    })
  })

  it('is for admins only', async () => {
    const res = await app.request('/api/admin/bill-committees', { headers: { Cookie: memberCookie } }, env)
    expect(res.status).toBe(403)
  })
})

describe('POST /admin/bill-committees/summary', () => {
  it('totals the bills a set of picks would have fully analyzed, before it is saved', async () => {
    const a = await seedBill({ externalId: 'legiscan:1', title: 'Court Fees', matchType: null })
    await seedBill({ externalId: 'legiscan:2', title: 'Parks', matchType: null })
    await refer(a, '101', 'Judiciary')

    const res = await app.request('/api/admin/bill-committees/summary', {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ committees: ['101'] }),
    }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total: 2, analyzed: 1, added: 1 })
  })

  it('refuses a list that is not committee ids', async () => {
    const res = await app.request('/api/admin/bill-committees/summary', {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ committees: 'Judiciary' }),
    }, env)
    expect(res.status).toBe(400)
  })
})

describe('saving the picks', () => {
  it('saves them in the config and registers with central', async () => {
    const res = await app.request('/api/admin/config', {
      method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bill_committees: ['101', '102'] }),
    }, env)

    expect(res.status).toBe(200)
    const row = await getDb(env.DB).select().from(associationConfig).where(eq(associationConfig.key, 'bill_committees')).get()
    expect(JSON.parse(row!.value)).toEqual(['101', '102'])
    expect(vi.mocked(registerWithCentral)).toHaveBeenCalledTimes(1)
  })

  it('refuses picks that are not committee ids', async () => {
    const res = await app.request('/api/admin/config', {
      method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bill_committees: ['Judiciary'] }),
    }, env)
    expect(res.status).toBe(400)
  })

  it('registration sends the picks to central', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'bill_committees', value: JSON.stringify(['101']) })
    const sync = await import('../../src/cron/sync') as unknown as { realRegisterWithCentral: typeof registerWithCentral }

    await sync.realRegisterWithCentral({ ...env, TENANT_ID: 't', APP_URL: 'https://t.example.com' } as never, db)

    const call = vi.mocked(centralFetch).mock.calls.find(c => c[1] === '/tenants/register')
    expect(JSON.parse(String(call?.[2]?.body)).committees).toEqual(['101'])
  })
})

describe('POST /admin/keyword-resync with committee picks', () => {
  it('keeps a match in a picked committee that the keywords no longer match', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values([
      { key: 'keywords', value: JSON.stringify(['election']) },
      { key: 'bill_committees', value: JSON.stringify(['101']) },
    ])
    const id = await seedBill({ externalId: 'legiscan:3', title: 'Court Fees', matchType: 'keyword' })
    await refer(id, '101', 'Judiciary')

    const res = await app.request('/api/admin/keyword-resync', { method: 'POST', headers: { Cookie: adminCookie } },
      { ...env, BILL_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) } })

    expect(res.status).toBe(200)
    const row = await db.select({ matchType: bills.matchType }).from(bills).where(eq(bills.id, id)).get()
    expect(row?.matchType).toBe('keyword')
  })

  it('queues an unanalyzed bill in a picked committee, with no keywords saved', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'bill_committees', value: JSON.stringify(['101']) })
    const id = await seedBill({ externalId: 'legiscan:4', title: 'Court Fees', matchType: null })
    await refer(id, '101', 'Judiciary')
    const sendBatch = vi.fn().mockResolvedValue(undefined)

    const res = await app.request('/api/admin/keyword-resync', { method: 'POST', headers: { Cookie: adminCookie } },
      { ...env, BILL_QUEUE: { sendBatch } })

    expect(res.status).toBe(200)
    expect(sendBatch.mock.calls.flatMap(c => c[0].map((m: { body: { billId: string } }) => m.body.billId))).toEqual(['legiscan:4'])
    expect(vi.mocked(centralFetch).mock.calls.some(c => String(c[1]).startsWith('/admin/sync-keywords/'))).toBe(true)
  })
})
