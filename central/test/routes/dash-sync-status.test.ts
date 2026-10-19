import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

// The other readers of the sync log: a failed pass is a row in it, and is not a sync.
const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }
const db = () => drizzle(env.DB, { schema })
const get = async (path: string) => {
  const res = await app.fetch(new Request(`http://central${path}`, { headers: AUTH }), TEST_ENV)
  expect(res.status).toBe(200)
  return (await res.json() as any).data
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

beforeEach(async () => {
  await clearDb()
  await db().insert(schema.tenants).values({ tenantId: 'ri', name: 'RI', stateCoverage: '["RI"]', active: true } as any)
  await db().insert(schema.sessions).values({
    sessionId: 1, state: 'RI', stateId: 41, yearStart: 2026, yearEnd: 2026, prefile: 0, sineDie: 0, prior: 0, special: 0,
    sessionTag: '', sessionTitle: 'RI 2026', sessionName: 'RI 2026', syncEnabled: true,
  } as any)
})

const log = (syncedAt: string, o: Record<string, unknown> = {}) => db().insert(schema.sessionSyncLog).values({
  sessionId: 1, sessionName: 'RI 2026', state: 'RI', syncedAt, billsChecked: 10, billsChanged: 2, billsQueued: 2, ...o,
} as any)

describe('GET /admin/dash/sync/ticks', () => {
  it('lists each tick\'s status and error, ok for a pass that finished', async () => {
    await log(ago(3_600_000))
    await log(ago(60_000), { status: 'failed', error: 'Error: boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    const { syncs } = await get('/admin/dash/sync/ticks')
    expect(syncs.map((s: any) => [s.status, s.error])).toEqual([['failed', 'Error: boom'], ['ok', null]])
  })
})

describe('GET /admin/dash/overview: last sync', () => {
  it('is the last pass that finished, not a failure after it', async () => {
    await log(ago(3 * 3_600_000), { billsChanged: 4 })
    await log(ago(60_000), { status: 'failed', error: 'boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    const { lastSync } = await get('/admin/dash/overview')
    expect(lastSync.billsChanged).toBe(4)
    expect(lastSync.ageSeconds).toBeGreaterThan(3 * 3600 - 60)
  })

  it('is null when every logged pass failed', async () => {
    await log(ago(60_000), { status: 'failed', error: 'boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    expect((await get('/admin/dash/overview')).lastSync).toBeNull()
  })
})

describe('GET /admin/dash/sync/states: stale', () => {
  it('stays stale when the only recent pass failed', async () => {
    await log(ago(200 * 3_600_000))
    await log(ago(60_000), { status: 'failed', error: 'boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    const ri = (await get('/admin/dash/sync/states')).states.find((s: any) => s.state === 'RI')
    expect(ri.stale).toBe(true)
  })

  it('is fresh after a pass that finished', async () => {
    await log(ago(60_000))
    const ri = (await get('/admin/dash/sync/states')).states.find((s: any) => s.state === 'RI')
    expect(ri.stale).toBe(false)
  })
})

describe('GET /admin/dash/sync/ticks/:id/changes', () => {
  const change = (id: string, detectedAt: string) => db().insert(schema.billChangeLog).values({
    id, billId: 1, changeType: 'status', oldValue: null, newValue: '1', detail: null, detectedAt,
  } as any)
  beforeEach(async () => {
    await db().insert(schema.bills).values({ billId: 1, sessionId: 1, state: 'RI', stateId: 41, billNumber: 'H1', changeHash: 'h', title: 't' } as any)
  })
  const idsOf = async (tickId: number) => (await get(`/admin/dash/sync/ticks/${tickId}/changes`)).changes.map((c: any) => c.id ?? c.detectedAt)

  it('bounds an ok tick\'s window at the next ok pass, so a failed row between does not cut it short', async () => {
    await log('2026-10-14 05:00:00')
    await log('2026-10-14 06:00:00', { status: 'failed', error: 'boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    await log('2026-10-14 13:00:00')
    await change('c1', '2026-10-14 05:30:00')
    await change('c2', '2026-10-14 07:30:00')
    await change('c3', '2026-10-14 14:00:00')
    const [first] = (await get('/admin/dash/sync/ticks')).syncs.slice().reverse()
    const data = await get(`/admin/dash/sync/ticks/${first.id}/changes`)
    expect(data.windowEnd).toBe('2026-10-14 13:00:00')
    expect(data.changes.map((c: any) => c.detectedAt)).toEqual(['2026-10-14 07:30:00', '2026-10-14 05:30:00'])
  })

  it('leaves an ok tick followed only by a failed row open-ended, with the changes after the failure', async () => {
    await log('2026-10-14 05:00:00')
    await log('2026-10-14 06:00:00', { status: 'failed', error: 'boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 })
    await change('c1', '2026-10-14 07:30:00')
    const [first] = (await get('/admin/dash/sync/ticks')).syncs.slice().reverse()
    const data = await get(`/admin/dash/sync/ticks/${first.id}/changes`)
    expect(data.changes.map((c: any) => c.detectedAt)).toEqual(['2026-10-14 07:30:00'])
  })

  it('still bounds a tick at the next ok pass of the same session', async () => {
    await log('2026-10-14 05:00:00')
    await log('2026-10-14 13:00:00')
    await change('c1', '2026-10-14 14:00:00')
    const [first] = (await get('/admin/dash/sync/ticks')).syncs.slice().reverse()
    expect((await get(`/admin/dash/sync/ticks/${first.id}/changes`)).changes).toEqual([])
  })
})
