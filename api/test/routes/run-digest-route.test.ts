import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import app from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, feedEvents } from '../../src/db/schema'

const TEST_ENV: any = { ...env, CENTRAL_ADMIN_SECRET: 'sek' }

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('POST /api/internal/run-digest', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('returns 401 without the admin secret', async () => {
    const res = await app.fetch(
      new Request('http://t/api/internal/run-digest', { method: 'POST' }),
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 with the wrong admin secret', async () => {
    const res = await app.fetch(
      new Request('http://t/api/internal/run-digest', {
        method: 'POST',
        headers: { 'x-admin-secret': 'wrong' },
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('returns 200 with the correct admin secret (no-op when digest module disabled)', async () => {
    const res = await app.fetch(
      new Request('http://t/api/internal/run-digest', {
        method: 'POST',
        headers: { 'x-admin-secret': 'sek' },
      }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
  })

  it('forces a send on a non-matching weekly day (ignoreSchedule)', async () => {
    const db = getDb(env.DB)
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-06-03T11:00:00Z'))  // Wednesday (UTC day 3)
    // Email digest module: weekly on Monday (1) — i.e. NOT today.
    const v = JSON.stringify({ 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '1' } } })
    await db.insert(associationConfig).values({ key: 'modules', value: v })
      .onConflictDoUpdate({ target: associationConfig.key, set: { value: v } })
    const u = await seedUser({ email: 'r@e.com' }); await seedSession(u)
    const billId = await seedBill({ billNumber: 'H 7', state: 'RI', session: '2026', priority: 'high' })
    await db.insert(feedEvents).values({ id: crypto.randomUUID(), type: 'position_set' as any, billId, userId: 'system', metadata: JSON.stringify({ position: 'Support' }) })

    const calls: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }) }))

    const res = await app.fetch(
      new Request('http://t/api/internal/run-digest', { method: 'POST', headers: { 'x-admin-secret': 'sek' } }),
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)   // forced send despite today != Monday
  })
})
