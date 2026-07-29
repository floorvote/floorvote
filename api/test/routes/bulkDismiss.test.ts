import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { eq, inArray } from 'drizzle-orm'

const MATCH = '2026-06-20 00:00:00'

describe('POST /bills/bulk-dismiss', () => {
  let adminToken: string, adminId: string
  let nm1: string, nm2: string, prioritized: string, manual: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
    nm1 = await seedBill({ billNumber: 'NM 1', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 80 })
    nm2 = await seedBill({ billNumber: 'NM 2', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 80 })
    prioritized = await seedBill({ billNumber: 'PRI 3', matchType: 'keyword', newMatchAt: MATCH, priority: 'high', triagedAt: MATCH, relevanceScore: 80 })
    manual = await seedBill({ billNumber: 'MAN 4', matchType: 'manual', newMatchAt: MATCH, relevanceScore: 80 })
  })

  it('dismisses only the un-triaged keyword new-matches in the selection', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [nm1, nm2, prioritized, manual] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dismissed: 2 })

    const db = getDb(env.DB)
    expect((await db.select().from(bills).where(eq(bills.id, nm1)).get())!.triagedAt).not.toBeNull()
    expect((await db.select().from(bills).where(eq(bills.id, nm2)).get())!.triagedAt).not.toBeNull()
    expect((await db.select().from(bills).where(eq(bills.id, manual)).get())!.triagedAt).toBeNull()
    expect((await db.select().from(bills).where(eq(bills.id, prioritized)).get())!.triagedAt).toBe(MATCH)
  })

  it('returns 403 for members', async () => {
    const memberId = await seedUser({ role: 'member', email: 'member@example.com' })
    const memberToken = await seedSession(memberId)
    const res = await SELF.fetch('http://localhost/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [nm1] }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects a body with neither ids nor filter', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('bulk-values reports newMatchCount for the selection', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/bulk-values?ids=${nm1}&ids=${nm2}&ids=${prioritized}&ids=${manual}`, {
      headers: { Cookie: `session=${adminToken}` },
    })
    const body = await res.json() as { newMatchCount: number }
    expect(body.newMatchCount).toBe(2)
  })

  it('dismisses a selection that crosses the chunk boundary (>100 bills)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 120; i++) {
      ids.push(await seedBill({ billNumber: `BIG ${i}`, matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 80 }))
    }
    const res = await SELF.fetch('http://localhost/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dismissed: 120 })

    const db = getDb(env.DB)
    // Verify in chunks — a single inArray over 120 ids would blow D1's 100-param cap.
    let triaged = 0
    for (let i = 0; i < ids.length; i += 90) {
      const rows = await db.select().from(bills).where(inArray(bills.id, ids.slice(i, i + 90))).all()
      triaged += rows.filter(r => r.triagedAt !== null).length
    }
    expect(triaged).toBe(120)
  })

  it('filter-mode dismiss scopes to new matches and ignores other bills', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { newMatches: '1' } }),
    })
    expect(res.status).toBe(200)
    // Only nm1 + nm2 qualify (prioritized is already triaged; manual is matchType manual).
    expect(await res.json()).toEqual({ dismissed: 2 })

    const db = getDb(env.DB)
    expect((await db.select().from(bills).where(eq(bills.id, nm1)).get())!.triagedAt).not.toBeNull()
    expect((await db.select().from(bills).where(eq(bills.id, manual)).get())!.triagedAt).toBeNull()
  })

  it('filter-mode dismiss clears a new-match queue larger than 1,000', async () => {
    // Seed 1,000 fresh qualifying new matches; with nm1 + nm2 from beforeEach the
    // qualifying queue is 1,002 — larger than the old 1,000-row dismiss guard.
    for (let i = 0; i < 1000; i++) {
      await seedBill({ billNumber: `BIGQ ${i}`, matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 50 })
    }
    const res = await SELF.fetch('http://localhost/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { newMatches: '1' } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dismissed: 1002 })
  })

  it('filter-mode dismiss with the newMatches chip OFF still touches only new matches', async () => {
    // Empty filter = "all bills"; the resolve must still narrow to the new-match queue.
    const res = await SELF.fetch('http://localhost/api/bills/bulk-dismiss', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: {} }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dismissed: 2 }) // nm1 + nm2 only

    const db = getDb(env.DB)
    expect((await db.select().from(bills).where(eq(bills.id, manual)).get())!.triagedAt).toBeNull()
    expect((await db.select().from(bills).where(eq(bills.id, prioritized)).get())!.triagedAt).toBe(MATCH)
  })
})
