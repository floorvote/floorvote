import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import migration0001 from '../../migrations-legiscan/0001_initial.sql?raw'
import migration0002 from '../../migrations-legiscan/0002_api_call_log_v2.sql?raw'
import migration0003 from '../../migrations-legiscan/0003_session_sync_log.sql?raw'
import migration0004 from '../../migrations-legiscan/0004_match_tracking.sql?raw'
import migration0005 from '../../migrations-legiscan/0005_bill_amendments_and_change_log.sql?raw'
import migration0006 from '../../migrations-legiscan/0006_texts_fetched_at.sql?raw'
import migration0013 from '../../migrations-legiscan/0013_tenants_queue_id.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map(s => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)
    .map(s => s + ';')
  return { name, queries }
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0002, '0002_api_call_log_v2'),
    parseMigration(migration0003, '0003_session_sync_log'),
    parseMigration(migration0004, '0004_match_tracking'),
    parseMigration(migration0005, '0005_bill_amendments_and_change_log'),
    parseMigration(migration0006, '0006_texts_fetched_at'),
    parseMigration(migration0013, '0013_tenants_queue_id'),
  ])
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
