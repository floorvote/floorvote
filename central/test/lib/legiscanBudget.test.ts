import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { legiscanCallsThisMonth, monthStartDb } from '../../src/lib/legiscanBudget'
import { app } from '../../src/index'
import { clearDb } from '../helpers/migrations'

// The month's LegiScan call count: the number the Budget page shows, and the
// one the stub refresh's budget floor reads. One function serves both, so the
// floor reads the same count an operator sees.

const NOW = new Date('2026-10-16T12:00:00Z')

beforeEach(async () => {
  await clearDb()
})

async function log(loggedAt: string, callType = 'getBill') {
  await drizzle(env.DB, { schema }).insert(schema.apiCallLog).values({ loggedAt, callType, params: '{}' })
}

describe('monthStartDb', () => {
  it('is the first of the month at midnight UTC, in the stored format', () => {
    expect(monthStartDb(NOW)).toBe('2026-10-01 00:00:00')
    expect(monthStartDb(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01-01 00:00:00')
  })
})

describe('legiscanCallsThisMonth', () => {
  it("counts this month's LegiScan calls, including the first day's, in either stored format", async () => {
    await log('2026-10-01 00:00:00')
    await log('2026-10-01 05:30:00')
    await log('2026-10-15 23:59:59', 'getMasterListRaw')
    // Rows from before nowDb() carry ISO timestamps.
    await log('2026-10-02T08:00:00.000Z')
    const db = drizzle(env.DB, { schema })
    expect(await legiscanCallsThisMonth(db, NOW)).toBe(4)
  })

  it("leaves out last month's calls and other providers' calls", async () => {
    await log('2026-09-30 23:59:59')
    await log('2026-09-30T23:59:59.000Z')
    await log('2026-10-05 10:00:00', 'lims:Members')
    await log('2026-10-05 10:00:00')
    const db = drizzle(env.DB, { schema })
    expect(await legiscanCallsThisMonth(db, NOW)).toBe(1)
  })

  it('is the count the Budget page shows', async () => {
    const thisMonth = monthStartDb(new Date())
    await log(thisMonth)
    await log(thisMonth.replace(' 00:00:00', ' 06:00:00'))
    await log(thisMonth, 'mga:Bills')
    const res = await app.fetch(new Request('http://central/admin/dash/overview', { headers: { Authorization: 'Bearer sek' } }), { ...env, ADMIN_SECRET: 'sek' } as any)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { apiBudget: { used: number } } }
    expect(body.data.apiBudget.used).toBe(2)
    expect(await legiscanCallsThisMonth(drizzle(env.DB, { schema }))).toBe(2)
  })
})
