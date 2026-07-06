import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema-legiscan'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { setSetting } from '../../src/lib/settings'

const TEST_ENV: any = { ...env, ADMIN_SECRET: 'sek' }
const AUTH = { Authorization: 'Bearer sek' }

beforeEach(async () => { await setupLsDb() })

describe('GET /admin/dash/budget/resend', () => {
  it('returns seeded defaults', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/budget/resend', { headers: AUTH }), TEST_ENV)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.data.monthlyLimit).toBe(50000)
    expect(body.data.monthlyUsed).toBe(0)
    expect(body.data.dailyLimit).toBeNull() // empty seed → null
    expect(body.data.usedAt).toBe('')
  })

  it('reflects updated settings', async () => {
    const db = drizzle(env.DB, { schema })
    await setSetting(db, 'resend_monthly_used', '4200')
    await setSetting(db, 'resend_monthly_limit', '50000')
    await setSetting(db, 'resend_daily_limit', '100')
    await setSetting(db, 'resend_daily_used', '12')
    await setSetting(db, 'resend_used_at', '2026-06-05T06:00:00Z')
    await setSetting(db, 'resend_last_429_at', '2026-06-04T10:00:00Z')

    const res = await app.fetch(new Request('http://central/admin/dash/budget/resend', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    expect(body.data.monthlyUsed).toBe(4200)
    expect(body.data.dailyLimit).toBe(100)
    expect(body.data.dailyUsed).toBe(12)
    expect(body.data.usedAt).toBe('2026-06-05T06:00:00Z')
    expect(body.data.last429At).toBe('2026-06-04T10:00:00Z')
  })
})

describe('GET /admin/dash/budget/resend monthDaily', () => {
  it('returns empty array when no rows', async () => {
    const res = await app.fetch(new Request('http://central/admin/dash/budget/resend', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    expect(Array.isArray(body.data.monthDaily)).toBe(true)
    expect(body.data.monthDaily).toHaveLength(0)
  })

  it('returns rows within 90 days ordered by date, excludes rows older than 90 days', async () => {
    const db = drizzle(env.DB, { schema })
    const today = new Date().toISOString().slice(0, 10)
    const thisMonth = today.slice(0, 7)
    const day1 = `${thisMonth}-01`
    const day2 = `${thisMonth}-02`
    const ninetyOneDaysAgo = new Date()
    ninetyOneDaysAgo.setUTCDate(ninetyOneDaysAgo.getUTCDate() - 91)
    const oldDate = ninetyOneDaysAgo.toISOString().slice(0, 10)

    await db.insert(schema.resendUsageDaily).values([
      { date: day1, monthlyUsed: 10, dailyUsed: 10, updatedAt: new Date().toISOString() },
      { date: day2, monthlyUsed: 25, dailyUsed: 15, updatedAt: new Date().toISOString() },
      { date: oldDate, monthlyUsed: 999, dailyUsed: 50, updatedAt: new Date().toISOString() },
    ])

    const res = await app.fetch(new Request('http://central/admin/dash/budget/resend', { headers: AUTH }), TEST_ENV)
    const body = await res.json() as any
    expect(body.data.monthDaily).toHaveLength(2)
    expect(body.data.monthDaily[0]).toEqual({ date: day1, monthlyUsed: 10 })
    expect(body.data.monthDaily[1]).toEqual({ date: day2, monthlyUsed: 25 })
    const found = body.data.monthDaily.find((d: any) => d.date === oldDate)
    expect(found).toBeUndefined()
  })
})
