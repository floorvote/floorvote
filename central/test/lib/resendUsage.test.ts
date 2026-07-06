import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'
import { snapshotResendDaily } from '../../src/lib/resendUsage'

beforeEach(async () => { await setupLsDb() })

describe('snapshotResendDaily', () => {
  it('inserts today\'s row', async () => {
    const db = drizzle(env.DB, { schema })
    await snapshotResendDaily(db, 1200, 30)
    const today = new Date().toISOString().slice(0, 10)
    const row = await db.select().from(schema.resendUsageDaily).where(eq(schema.resendUsageDaily.date, today)).get()
    expect(row?.monthlyUsed).toBe(1200)
    expect(row?.dailyUsed).toBe(30)
  })

  it('upserts (latest wins within a day)', async () => {
    const db = drizzle(env.DB, { schema })
    await snapshotResendDaily(db, 1200, 30)
    await snapshotResendDaily(db, 1250, 35)
    const rows = await db.select().from(schema.resendUsageDaily).all()
    expect(rows.length).toBe(1)
    expect(rows[0].monthlyUsed).toBe(1250)
    expect(rows[0].dailyUsed).toBe(35)
  })
})
