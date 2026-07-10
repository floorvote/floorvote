import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { eq, sql } from 'drizzle-orm'

describe('0058 start-at-zero backfill', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('marks pre-existing keyword bills triaged so the worklist starts empty', async () => {
    const db = getDb(env.DB)
    const kw = await seedBill({ billNumber: 'K 1', matchType: 'keyword', newMatchAt: '2026-01-01 00:00:00' })
    const manual = await seedBill({ billNumber: 'M 1', matchType: 'manual', newMatchAt: '2026-01-01 00:00:00' })

    await db.run(sql`UPDATE bills SET triaged_at = datetime('now') WHERE match_type = 'keyword' AND triaged_at IS NULL`)

    const kwRow = await db.select().from(bills).where(eq(bills.id, kw)).get()
    const manualRow = await db.select().from(bills).where(eq(bills.id, manual)).get()
    expect(kwRow!.triagedAt).not.toBeNull()
    expect(manualRow!.triagedAt).toBeNull()
  })
})
