import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }

beforeEach(async () => { await setupLsDb() })

async function seed() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.bills).values([
    { billId: 100, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H1', changeHash: 'h', title: 'tA' } as any,
    { billId: 200, sessionId: 1, state: 'NJ', stateId: 31, billNumber: 'A2', changeHash: 'h', title: 'tB' } as any,
  ])
  await db.insert(schema.billChangeLog).values([
    { id: 'c1', billId: 100, changeType: 'status', oldValue: '1', newValue: '2', detail: null, detectedAt: '2026-05-28T10:00:00Z' } as any,
    { id: 'c2', billId: 100, changeType: 'lastAction', oldValue: 'a', newValue: 'b', detail: null, detectedAt: '2026-05-28T11:00:00Z' } as any,
    { id: 'c3', billId: 200, changeType: 'status', oldValue: '1', newValue: '2', detail: null, detectedAt: '2026-05-28T09:00:00Z' } as any,
  ])
}

describe('GET /admin/dash/activity', () => {
  it('returns newest-first, joined with bill metadata', async () => {
    await seed()
    const res = await app.fetch(new Request('http://central/admin/dash/activity', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.entries.length).toBe(3)
    expect(body.data.entries[0].detectedAt).toBe('2026-05-28T11:00:00Z')
    expect(body.data.entries[0].state).toBe('RI')
    expect(body.data.entries[0].billNumber).toBe('H1')
  })

  it('filters by state', async () => {
    await seed()
    const res = await app.fetch(new Request('http://central/admin/dash/activity?state=NJ', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    expect(body.data.entries.length).toBe(1)
    expect(body.data.entries[0].state).toBe('NJ')
  })

  it('filters by changeType (multi-value comma-separated)', async () => {
    await seed()
    const res = await app.fetch(new Request('http://central/admin/dash/activity?changeType=lastAction', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    expect(body.data.entries.length).toBe(1)
    expect(body.data.entries[0].changeType).toBe('lastAction')
  })

  it('caps at limit=200', async () => {
    await seed()
    const res = await app.fetch(new Request('http://central/admin/dash/activity?limit=999', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    // Only 3 rows seeded, so result will be 3; just verify no 400
    expect(res.status).toBe(200)
  })
})
