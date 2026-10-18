import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

// Release 1 of the neutral handle rename (#305): central's bill routes take a
// bill by its neutral handle as readily as by its legacy one or a bare id, and
// every handle central sends is still the legacy form.

const headers = { 'x-admin-secret': 'test-secret', 'Content-Type': 'application/json' }

beforeEach(async () => {
  await setupLsDb()
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

  it('still sends the legacy handle as the bill\'s billId, whichever form asked', async () => {
    for (const asked of ['bill:101', 'legiscan:101', '101']) {
      const body = await (await get(asked)).json() as { billId: string }
      expect(body.billId).toBe('legiscan:101')
    }
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
