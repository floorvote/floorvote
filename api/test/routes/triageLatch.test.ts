import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

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
