import { describe, it, expect, beforeEach } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('PATCH /bills/:id/triage-dismiss', () => {
  let adminToken: string
  let adminId: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
    billId = await seedBill({ billNumber: 'HB 1', title: 'Election Act', matchType: 'keyword' })
  })

  it('admin dismiss sets timestamp + actor', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/triage-dismiss`, {
      method: 'PATCH', headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const row = await getDb(env.DB).select().from(bills).where(eq(bills.id, billId)).get()
    expect(row!.triageDismissedAt).not.toBeNull()
    expect(row!.triageDismissedBy).toBe(adminId)
  })

  it('is idempotent — second dismiss preserves the original dismisser', async () => {
    await SELF.fetch(`http://localhost/api/bills/${billId}/triage-dismiss`, {
      method: 'PATCH', headers: { Cookie: `session=${adminToken}` },
    })
    const firstRow = await getDb(env.DB).select().from(bills).where(eq(bills.id, billId)).get()

    const admin2 = await seedUser({ role: 'admin', email: 'admin2@example.com' })
    const admin2Token = await seedSession(admin2)
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/triage-dismiss`, {
      method: 'PATCH', headers: { Cookie: `session=${admin2Token}` },
    })
    expect(res.status).toBe(200)
    const row = await getDb(env.DB).select().from(bills).where(eq(bills.id, billId)).get()
    expect(row!.triageDismissedBy).toBe(adminId)
    expect(row!.triageDismissedAt).toBe(firstRow!.triageDismissedAt)
  })

  it('returns 403 for members', async () => {
    const memberId = await seedUser({ role: 'member', email: 'member@example.com' })
    const memberToken = await seedSession(memberId)
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/triage-dismiss`, {
      method: 'PATCH', headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(403)
  })

  it('returns 404 for an unknown bill', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/does-not-exist/triage-dismiss`, {
      method: 'PATCH', headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(404)
  })
})
