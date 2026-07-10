import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { eq, inArray } from 'drizzle-orm'

const MATCH = '2026-06-20 00:00:00'
type ListResp = { bills: { billNumber: string }[] }

describe('setting a priority latches a new match as triaged', () => {
  let adminToken: string, adminId: string, billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
    billId = await seedBill({ billNumber: 'NM 1', matchType: 'keyword', newMatchAt: MATCH, relevanceScore: 80 })
  })

  async function setPriority(priority: string | null) {
    return SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority }),
    })
  }

  async function newMatchNumbers(): Promise<string[]> {
    const res = await SELF.fetch('http://localhost/api/bills?newMatches=1', { headers: { Cookie: `session=${adminToken}` } })
    return ((await res.json()) as ListResp).bills.map(b => b.billNumber)
  }

  it('stamps triaged_at + triaged_by when a priority is set', async () => {
    expect(await newMatchNumbers()).toEqual(['NM 1'])
    await setPriority('high')
    const row = await getDb(env.DB).select().from(bills).where(eq(bills.id, billId)).get()
    expect(row!.triagedAt).not.toBeNull()
    expect(row!.triagedBy).toBe(adminId)
    expect(await newMatchNumbers()).toEqual([])
  })

  it('does NOT re-new the bill when the priority is later cleared', async () => {
    await setPriority('high')
    await setPriority(null)
    const row = await getDb(env.DB).select().from(bills).where(eq(bills.id, billId)).get()
    expect(row!.priority).toBeNull()
    expect(row!.triagedAt).not.toBeNull()
    expect(await newMatchNumbers()).toEqual([])
  })

  it('is idempotent — a later priority change by another admin preserves the original triager', async () => {
    await setPriority('high')
    const firstRow = await getDb(env.DB).select().from(bills).where(eq(bills.id, billId)).get()

    const admin2 = await seedUser({ role: 'admin', email: 'admin2@example.com' })
    const admin2Token = await seedSession(admin2)
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${admin2Token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'medium' }),
    })
    expect(res.status).toBe(200)

    const row = await getDb(env.DB).select().from(bills).where(eq(bills.id, billId)).get()
    expect(row!.priority).toBe('medium')
    expect(row!.triagedBy).toBe(adminId)
    expect(row!.triagedAt).toBe(firstRow!.triagedAt)
  })
})

describe('bulk priority-set latches new matches as triaged', () => {
  let adminToken: string, adminId: string, a: string, b: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
    a = await seedBill({ billNumber: 'B A', matchType: 'keyword', newMatchAt: '2026-06-20 00:00:00', relevanceScore: 80 })
    b = await seedBill({ billNumber: 'B B', matchType: 'keyword', newMatchAt: '2026-06-20 00:00:00', relevanceScore: 80 })
  })

  it('stamps triaged_at on all selected bills when a bulk priority is applied', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [a, b], priority: 'low' }),
    })
    expect(res.status).toBe(200)
    const rows = await getDb(env.DB).select().from(bills).where(inArray(bills.id, [a, b])).all()
    for (const r of rows) {
      expect(r.triagedAt).not.toBeNull()
      expect(r.triagedBy).toBe(adminId)
    }
  })

  it('applies priority and latches triage across a selection that crosses the chunk boundary (>100 bills)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 120; i++) {
      ids.push(await seedBill({ billNumber: `BIG ${i}`, matchType: 'keyword', newMatchAt: '2026-06-20 00:00:00', relevanceScore: 80 }))
    }
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, priority: 'low' }),
    })
    expect(res.status).toBe(200)

    const db = getDb(env.DB)
    // Verify in chunks — a single inArray over 120 ids would blow D1's 100-param cap.
    let withLowPriority = 0
    let withTriagedAt = 0
    for (let i = 0; i < ids.length; i += 90) {
      const rows = await db.select().from(bills).where(inArray(bills.id, ids.slice(i, i + 90))).all()
      withLowPriority += rows.filter(r => r.priority === 'low').length
      withTriagedAt += rows.filter(r => r.triagedAt !== null).length
    }
    expect(withLowPriority).toBe(120)
    expect(withTriagedAt).toBe(120)
  })
})
