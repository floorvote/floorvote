import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, feedEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('new-match data model', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('accepts new_match columns and a bill_matched feed event', async () => {
    const db = getDb(env.DB)
    const id = crypto.randomUUID()
    await db.insert(bills).values({
      id, billNumber: 'HB 1', title: 'T', state: 'NJ',
      matchType: 'keyword', newMatchAt: '2026-06-21 00:00:00',
    })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'bill_matched', billId: id, userId: 'system',
    })

    const row = await db.select().from(bills).where(eq(bills.id, id)).get()
    expect(row?.newMatchAt).toBe('2026-06-21 00:00:00')
    expect(row?.triageDismissedAt).toBeNull()
    const ev = await db.select().from(feedEvents).where(eq(feedEvents.billId, id)).get()
    expect(ev?.type).toBe('bill_matched')
  })
})
