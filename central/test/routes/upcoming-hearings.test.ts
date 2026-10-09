import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

beforeEach(async () => {
  await setupLsDb()
})

async function seed() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({
    tenantId: 't1', name: 'T1', active: true, stateCoverage: '["RI"]',
  })
  await db.insert(schema.sessions).values({
    sessionId: 100, state: 'RI', stateId: 39, yearStart: 2026, yearEnd: 2026,
    sessionTitle: '2026', sessionName: '2026 Regular Session', sessionTag: '',
    prefile: 0, sineDie: 0, prior: 0, special: 0,
  })
  await db.insert(schema.bills).values({
    billId: 1, changeHash: 'h', sessionId: 100, state: 'RI', stateId: 39,
    billNumber: 'H1', title: 'Test bill', status: 1,
  })
  await db.insert(schema.billTenants).values({
    billId: 1, tenantId: 't1', matchType: 'keyword',
  })

  const today = new Date().toISOString().slice(0, 10)
  const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
  const past = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)

  await db.insert(schema.billCalendar).values([
    { id: 'a', billId: 1, eventHash: 'eh-future', type: 'Hearing', date: future, time: '10:00:00', location: 'Room 1', description: 'Future hearing' },
    { id: 'b', billId: 1, eventHash: 'eh-today', type: 'Hearing', date: today, time: null, location: null, description: 'Today hearing' },
    { id: 'c', billId: 1, eventHash: 'eh-past', type: 'Hearing', date: past, time: null, location: null, description: 'Past hearing' },
  ])
}

describe('GET /tenants/:tenantId/upcoming-hearings', () => {
  it('returns 401 without admin secret', async () => {
    const res = await app.request('/api/tenants/t1/upcoming-hearings', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns upcoming hearings ordered by date, excluding past', async () => {
    await seed()
    const res = await app.request(
      '/api/tenants/t1/upcoming-hearings',
      { headers: { 'x-admin-secret': 'test-secret' } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(body).toHaveLength(2)
    expect(body[0].eventHash).toBe('eh-today')
    expect(body[1].eventHash).toBe('eh-future')
    expect(body[0]).toMatchObject({
      billId: 1,
      billNumber: 'H1',
      billTitle: 'Test bill',
      state: 'RI',
      sessionName: '2026 Regular Session',
    })
  })

  it('respects days query param', async () => {
    await seed()
    const res = await app.request(
      '/api/tenants/t1/upcoming-hearings?days=1',
      { headers: { 'x-admin-secret': 'test-secret' } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(body).toHaveLength(1)
    expect(body[0].eventHash).toBe('eh-today')
  })

  it('scopes to the billIds param when provided (prioritized-bills path)', async () => {
    await seed()
    const db = drizzle(env.DB, { schema })
    // A second bill linked to t1 with a future hearing. Without billIds it
    // would be returned; with billIds=1 it must be filtered out server-side.
    await db.insert(schema.bills).values({
      billId: 2, changeHash: 'h', sessionId: 100, state: 'RI', stateId: 39,
      billNumber: 'H2', title: 'Second bill', status: 1,
    })
    await db.insert(schema.billTenants).values({ billId: 2, tenantId: 't1', matchType: 'keyword' })
    const future = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)
    await db.insert(schema.billCalendar).values({
      id: 'e', billId: 2, eventHash: 'eh-second', type: 'Hearing', date: future, time: null,
    })

    const res = await app.request(
      '/api/tenants/t1/upcoming-hearings?billIds=1',
      { headers: { 'x-admin-secret': 'test-secret' } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(body.every(h => h.billId === 1)).toBe(true)
    expect(body.find(h => h.eventHash === 'eh-second')).toBeUndefined()
  })

  it('returns nothing when billIds is present but empty (no prioritized bills)', async () => {
    await seed()
    const res = await app.request(
      '/api/tenants/t1/upcoming-hearings?billIds=',
      { headers: { 'x-admin-secret': 'test-secret' } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('excludes hearings from bills not linked to the tenant', async () => {
    await seed()
    const db = drizzle(env.DB, { schema })
    // Add another bill with a hearing, but not linked to t1
    await db.insert(schema.bills).values({
      billId: 2, changeHash: 'h', sessionId: 100, state: 'RI', stateId: 39,
      billNumber: 'H2', title: 'Other bill', status: 1,
    })
    const future = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10)
    await db.insert(schema.billCalendar).values({
      id: 'd', billId: 2, eventHash: 'eh-other', type: 'Hearing', date: future, time: null,
    })

    const res = await app.request(
      '/api/tenants/t1/upcoming-hearings',
      { headers: { 'x-admin-secret': 'test-secret' } },
      env,
    )
    const body = await res.json() as any[]
    expect(body.find(h => h.eventHash === 'eh-other')).toBeUndefined()
  })
})
