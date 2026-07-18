import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { memberVotes, users } from '../../src/db/schema'
import { eq } from 'drizzle-orm'

describe('deactivated members drop out of vote tallies', () => {
  let adminTok: string, billId: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    adminTok = await seedSession(await seedUser({ role: 'admin', email: 'a@x.com' }))
    billId = await seedBill({ matchType: 'keyword', title: 'Tally bill' })
    const active = await seedUser({ role: 'member', email: 'active@x.com' })
    const gone = await seedUser({ role: 'member', email: 'gone@x.com', deactivatedAt: new Date().toISOString() })
    const db = getDb(env.DB)
    await db.insert(memberVotes).values([
      { id: crypto.randomUUID(), userId: active, billId, position: 'support' },
      { id: crypto.randomUUID(), userId: gone, billId, position: 'oppose' },
    ])
  })

  it('bill detail counts only the active voter', async () => {
    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<{ voteCounts: { support: number; oppose: number; neutral: number } }>()
    expect(body.voteCounts.support).toBe(1)
    expect(body.voteCounts.oppose).toBe(0)
  })

  it('reactivating restores the vote', async () => {
    await getDb(env.DB).update(users).set({ deactivatedAt: null }).where(eq(users.email, 'gone@x.com'))
    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: `session=${adminTok}` } })
    const body = await res.json<{ voteCounts: { oppose: number } }>()
    expect(body.voteCounts.oppose).toBe(1)
  })
})
