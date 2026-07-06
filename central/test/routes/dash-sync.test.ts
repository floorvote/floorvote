import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }

beforeEach(async () => { await setupLsDb() })

async function seed() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values([
    { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true } as any,
  ])
  await db.insert(schema.sessions).values([
    { sessionId: 1, state: 'RI', stateId: 41, yearStart: 2026, yearEnd: 2026, prefile: 0, sineDie: 0, prior: 0, special: 0, sessionTag: '', sessionTitle: 'RI 2026', sessionName: 'RI 2026', syncEnabled: true } as any,
  ])
  await db.insert(schema.sessionSyncLog).values([
    { sessionId: 1, sessionName: 'RI 2026', state: 'RI', syncedAt: '2026-05-28T10:00:00Z', billsChecked: 10, billsChanged: 0, billsQueued: 0 } as any,
    { sessionId: 1, sessionName: 'RI 2026', state: 'RI', syncedAt: '2026-05-28T11:00:00Z', billsChecked: 5, billsChanged: 1, billsQueued: 1 } as any,
  ])
  await db.insert(schema.bills).values([
    { billId: 1, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H1', changeHash: 'h', title: 't' } as any,
  ])
  await db.insert(schema.billChangeLog).values([
    { id: 'c1', billId: 1, changeType: 'status', oldValue: null, newValue: '1', detail: null, detectedAt: '2026-05-28T11:30:00Z' } as any,
  ])
}

describe('GET /admin/dash/sync/keyword-union', () => {
  it('returns per-state keyword union with contributing tenants', async () => {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.tenants).values([
      { tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true } as any,
      { tenantId: 'acme', name: 'Acme', stateCoverage: '["RI","NJ"]', active: true } as any,
    ])
    await db.insert(schema.keywordRegistry).values([
      { tenantId: 'ri', keyword: 'election' } as any,
      { tenantId: 'ri', keyword: 'ballot' } as any,
      { tenantId: 'acme', keyword: 'voter' } as any,
      { tenantId: 'acme', keyword: 'ballot' } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/sync/keyword-union', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const ri = body.data.states.find((s: any) => s.state === 'RI')
    expect(ri.contributingTenants).toEqual(expect.arrayContaining(['ri', 'acme']))
    // union de-dupes "ballot"
    expect(ri.keywordCount).toBe(3) // election, ballot, voter
    const nj = body.data.states.find((s: any) => s.state === 'NJ')
    expect(nj.contributingTenants).toEqual(['acme'])
    expect(nj.keywordCount).toBe(2)
  })
})

describe('GET /admin/dash/sync/api-budget', () => {
  it('returns monthly total, daily series, and top callTypes', async () => {
    const db = drizzle(env.DB, { schema })
    const today = new Date().toISOString().slice(0, 10)
    await db.insert(schema.apiCallLog).values([
      { callType: 'getBill', params: '{}', loggedAt: `${today}T00:00:00Z` } as any,
      { callType: 'getBill', params: '{}', loggedAt: `${today}T01:00:00Z` } as any,
      { callType: 'getMasterList', params: '{}', loggedAt: `${today}T02:00:00Z` } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/sync/api-budget', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.limit).toBe(30000)
    expect(body.data.monthToDate).toBe(3)
    const todayEntry = body.data.daily.find((d: any) => d.date === today)
    expect(todayEntry?.calls).toBe(3)
    expect(body.data.topCalls[0].callType).toBe('getBill')
    expect(body.data.topCalls[0].calls).toBe(2)
  })

  it('returns a 90-day daily series (monthDaily), zero-filled to today', async () => {
    const db = drizzle(env.DB, { schema })
    const today = new Date().toISOString().slice(0, 10)
    const ninetyDaysAgo = new Date()
    ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 89)
    ninetyDaysAgo.setUTCHours(0, 0, 0, 0)
    const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().slice(0, 10)
    await db.insert(schema.apiCallLog).values([
      { callType: 'getBill', params: '{}', loggedAt: `${ninetyDaysAgoStr}T00:00:00Z` } as any,
      { callType: 'getBill', params: '{}', loggedAt: `${today}T01:00:00Z` } as any,
      { callType: 'getBill', params: '{}', loggedAt: `${today}T02:00:00Z` } as any,
    ])
    const res = await app.fetch(new Request('http://central/admin/dash/sync/api-budget', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    expect(Array.isArray(body.data.monthDaily)).toBe(true)
    expect(body.data.monthDaily).toHaveLength(90)
    expect(body.data.monthDaily[0].date).toBe(ninetyDaysAgoStr)
    const last = body.data.monthDaily[body.data.monthDaily.length - 1]
    expect(last.date).toBe(today)
    expect(last.calls).toBeGreaterThanOrEqual(2)
  })

  it('excludes rows older than 90 days from monthDaily', async () => {
    const db = drizzle(env.DB, { schema })
    const ninetyOneDaysAgo = new Date()
    ninetyOneDaysAgo.setUTCDate(ninetyOneDaysAgo.getUTCDate() - 91)
    ninetyOneDaysAgo.setUTCHours(0, 0, 0, 0)
    const oldDate = ninetyOneDaysAgo.toISOString().slice(0, 10)
    await db.insert(schema.apiCallLog).values([
      { callType: 'getBill', params: '{}', loggedAt: `${oldDate}T00:00:00Z` } as any,
    ])
    const res = await app.fetch(new Request('http://central/admin/dash/sync/api-budget', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    const found = body.data.monthDaily.find((d: any) => d.date === oldDate)
    expect(found).toBeUndefined()
  })
})

describe('GET /admin/dash/sync/ticks', () => {
  it('returns recent syncs newest-first', async () => {
    await seed()
    const res = await app.fetch(new Request('http://central/admin/dash/sync/ticks', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.syncs.length).toBeGreaterThan(0)
    expect(body.data.syncs[0].state).toBe('RI')
    expect(typeof body.data.syncs[0].billsChecked).toBe('number')
  })
})

describe('GET /admin/dash/sync/sessions', () => {
  it('returns active and sineDie buckets with bill count', async () => {
    await seed()
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values([
      { sessionId: 2, state: 'RI', stateId: 41, yearStart: 2024, yearEnd: 2024, prefile: 0, sineDie: 1, prior: 1, special: 0, sessionTag: '', sessionTitle: 'RI 2024', sessionName: 'RI 2024', syncEnabled: true } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/sync/sessions', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.active.length).toBe(1)
    expect(body.data.sineDie.length).toBe(1)
    const row = body.data.active[0]
    expect(row.sessionId).toBe(1)
    expect(row.state).toBe('RI')
    expect(row.billCount).toBe(1)
    expect(row.sineDie).toBe(false)
    expect(Array.isArray(row.fullSyncHours)).toBe(true)
    expect(row.fullSyncIsDefault).toBe(true)
    expect(body.data.sineDie[0].sessionId).toBe(2)
    expect(body.data.sineDie[0].sineDie).toBe(true)
  })

  it('sync-disabled (syncEnabled=false) non-sineDie session appears in active bucket', async () => {
    await seed()
    const db = drizzle(env.DB, { schema })
    // sessionId 3: not sine die, sync disabled — must still appear in active (not vanish)
    await db.insert(schema.sessions).values([
      { sessionId: 3, state: 'NJ', stateId: 30, yearStart: 2026, yearEnd: 2026, prefile: 0, sineDie: 0, prior: 0, special: 0, sessionTag: '', sessionTitle: 'NJ 2026', sessionName: 'NJ 2026', syncEnabled: false } as any,
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/sync/sessions', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any

    const disabled = body.data.active.find((s: any) => s.sessionId === 3)
    expect(disabled).toBeDefined()
    expect(disabled.syncEnabled).toBe(false)
    expect(disabled.sineDie).toBe(false)

    // must NOT appear in sineDie
    const inSineDie = body.data.sineDie.find((s: any) => s.sessionId === 3)
    expect(inSineDie).toBeUndefined()
  })
})

describe('GET /admin/dash/sync/states', () => {
  it('returns one row per state with at least one tenant', async () => {
    await seed()
    const res = await app.fetch(new Request('http://central/admin/dash/sync/states', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.states.length).toBe(1)
    const row = body.data.states[0]
    expect(row.state).toBe('RI')
    expect(row.activeSessions).toBe(1)
    expect(row.lastSyncedAt).toBe('2026-05-28T11:00:00Z')
    expect(row.lastBillChangeAt).toBe('2026-05-28T11:30:00Z')
    expect(typeof row.stale).toBe('boolean')
  })
})

describe('PUT /admin/dash/sync/session/:sessionId', () => {
  async function seedActive() {
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.sessions).values([
      { sessionId: 10, state: 'RI', stateId: 41, yearStart: 2026, yearEnd: 2026, prefile: 0, sineDie: 0, prior: 0, special: 0, sessionTag: '', sessionTitle: 'RI 2026', sessionName: 'RI 2026', syncEnabled: true } as any,
      { sessionId: 11, state: 'RI', stateId: 41, yearStart: 2024, yearEnd: 2024, prefile: 0, sineDie: 1, prior: 1, special: 0, sessionTag: '', sessionTitle: 'RI 2024', sessionName: 'RI 2024', syncEnabled: true } as any,
    ])
  }

  it('persists deduped, sorted hours and syncEnabled', async () => {
    await seedActive()
    const res = await app.fetch(new Request('http://central/admin/dash/sync/session/10', {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullSyncHoursEt: [13, 5, 5, 23], rawSyncHoursEt: [9, 7, 7], syncEnabled: true }),
    }), TEST_ENV)
    expect(res.status).toBe(200)
    const db = drizzle(env.DB, { schema })
    const row = await db.select().from(schema.sessions).where(eq(schema.sessions.sessionId, 10)).get()
    expect(JSON.parse(row!.fullSyncHoursEt!)).toEqual([5, 13, 23])
    expect(JSON.parse(row!.rawSyncHoursEt!)).toEqual([7, 9])
    expect(row!.syncEnabled).toBe(true)
  })

  it('rejects hours outside 0-23', async () => {
    await seedActive()
    const res = await app.fetch(new Request('http://central/admin/dash/sync/session/10', {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullSyncHoursEt: [5, 24], rawSyncHoursEt: [], syncEnabled: true }),
    }), TEST_ENV)
    expect(res.status).toBe(400)
  })

  it('requires >=1 full hour when enabled', async () => {
    await seedActive()
    const res = await app.fetch(new Request('http://central/admin/dash/sync/session/10', {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullSyncHoursEt: [], rawSyncHoursEt: [9], syncEnabled: true }),
    }), TEST_ENV)
    expect(res.status).toBe(400)
  })

  it('allows empty full hours when disabled', async () => {
    await seedActive()
    const res = await app.fetch(new Request('http://central/admin/dash/sync/session/10', {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullSyncHoursEt: [], rawSyncHoursEt: [], syncEnabled: false }),
    }), TEST_ENV)
    expect(res.status).toBe(200)
  })

  it('rejects edits to a sine die session', async () => {
    await seedActive()
    const res = await app.fetch(new Request('http://central/admin/dash/sync/session/11', {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullSyncHoursEt: [5], rawSyncHoursEt: [], syncEnabled: true }),
    }), TEST_ENV)
    expect(res.status).toBe(409)
  })

  it('404s an unknown session', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/sync/session/999', {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullSyncHoursEt: [5], rawSyncHoursEt: [], syncEnabled: true }),
    }), TEST_ENV)
    expect(res.status).toBe(404)
  })
})
