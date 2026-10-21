import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index'
import { clearDb } from '../helpers/migrations'

// The neutral handle rename (#305): central's bill routes take a bill by its
// neutral handle as readily as by its legacy one or a bare id. Release 2 names
// the bill by its neutral handle only to an instance whose request says it
// reads one (the x-handle-form header), and by its legacy handle otherwise.

const headers = { 'x-admin-secret': 'test-secret', 'Content-Type': 'application/json' }

beforeEach(async () => {
  await clearDb()
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({ sessionId: 1, state: 'RI', stateId: 39, yearStart: 2026, yearEnd: 2026, sessionName: 'RI 2026', sessionTitle: 'Regular' })
  await db.insert(schema.bills).values([
    { billId: 101, sessionId: 1, state: 'RI', stateId: 39, billNumber: 'H101', title: 'Bill 101', changeHash: 'h', status: 1 },
    { billId: 102, sessionId: 1, state: 'RI', stateId: 39, billNumber: 'H102', title: 'Bill 102', changeHash: 'h', status: 1 },
    // An id past 2^31, as a provider-assigned row id can be.
    { billId: 2147483649, sessionId: 1, state: 'RI', stateId: 39, billNumber: 'H900', title: 'Bill 900', changeHash: 'h', status: 1 },
  ])
})

const get = (id: string, suffix = '') => app.request(`/api/bills/${id}${suffix}`, { headers }, env)

describe('GET /bills/:id by neutral handle', () => {
  it.each([[101], [102], [2147483649]])('serves bill %i by its neutral handle exactly as by its legacy handle and bare id', async (id) => {
    const legacy = await (await get(`legiscan:${id}`)).json()
    const neutral = await get(`bill:${id}`)
    expect(neutral.status).toBe(200)
    expect(await neutral.json()).toEqual(legacy)
    expect(await (await get(String(id))).json()).toEqual(legacy)
  })

  it('sends the legacy handle as the bill\'s billId to a caller that does not ask for neutral, whichever form asked', async () => {
    for (const asked of ['bill:101', 'legiscan:101', '101']) {
      const body = await (await get(asked)).json() as { billId: string }
      expect(body.billId).toBe('legiscan:101')
    }
  })

  it('sends the neutral handle as the bill\'s billId to a caller whose request says it reads one, whichever form asked', async () => {
    for (const asked of ['bill:101', 'legiscan:101', '101']) {
      const res = await app.request(`/api/bills/${asked}`, { headers: { ...headers, 'x-handle-form': 'neutral' } }, env)
      expect(((await res.json()) as { billId: string }).billId).toBe('bill:101')
    }
  })

  it.each([['legacy'], [''], ['NEUTRAL'], ['bill']])('sends the legacy handle for an x-handle-form of %j', async (value) => {
    const res = await app.request('/api/bills/bill:101', { headers: { ...headers, 'x-handle-form': value } }, env)
    expect(((await res.json()) as { billId: string }).billId).toBe('legiscan:101')
  })

  it('serves the same bill either way, apart from its billId', async () => {
    const legacy = await (await get('legiscan:101')).json() as Record<string, unknown>
    const neutral = await (await app.request('/api/bills/legiscan:101', { headers: { ...headers, 'x-handle-form': 'neutral' } }, env)).json() as Record<string, unknown>
    expect({ ...neutral, billId: legacy.billId }).toEqual(legacy)
  })

  it('serves the changes feed by neutral handle', async () => {
    const res = await get('bill:101', '/changes')
    expect(res.status).toBe(200)
  })

  it('404s a neutral handle for a bill central does not have', async () => {
    expect((await get('bill:5555')).status).toBe(404)
  })

  it.each([
    ['empty prefix id', 'bill:'],
    ['id zero', 'bill:0'],
    ['trailing junk', 'bill:101abc'],
    ['a provider name inside the prefix', 'legiscan-bill:101'],
    ['a wrong prefix', 'item:101'],
  ])('400s %s', async (_, id) => {
    expect((await get(id)).status).toBe(400)
  })
})

describe('POST /bills/rich-batch with mixed handle forms', () => {
  it('reads each bill once, whichever form names it', async () => {
    const res = await app.request('/api/bills/rich-batch', {
      method: 'POST', headers, body: JSON.stringify({ ids: ['bill:101', 'bill:102', 'bill:101', 'bill:12abc', 'bill:0'] }),
    }, env)
    expect(res.status).toBe(200)
    const body = await res.json() as { byId: Record<string, unknown> }
    expect(Object.keys(body.byId).sort()).toEqual(['101', '102'])
  })
})
