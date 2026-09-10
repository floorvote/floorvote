import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'

/** Space-separated UTC, `minutesAgo` before now — the nowDb() wire format. */
function ago(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString().slice(0, 19).replace('T', ' ')
}

async function seedStalledBill(externalId: string) {
  const db = getDb(env.DB)
  await db.insert(bills).values({
    id: crypto.randomUUID(),
    externalId,
    billNumber: 'SB 1',
    title: 'Stalled Bill',
    state: 'NV',
    session: '2026 Regular Session',
    sessionId: 'nv:2026',
    tags: JSON.stringify([]),
    matchType: 'keyword',
    isDraft: false,
    aiAttemptedAt: ago(120),
    aiProcessedAt: null,
    aiSkipReason: null,
    aiHealAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as typeof bills.$inferInsert)
}

describe('POST /admin/heal-ai', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
  })

  it('returns 503 when queue not configured', async () => {
    const res = await app.request('/api/admin/heal-ai', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: undefined })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Queue not configured' })
  })

  it('queues stalled bills and returns the counts', async () => {
    await seedStalledBill('legiscan:1')

    const sent: unknown[] = []
    const mockQueue = {
      send: vi.fn().mockImplementation((msg: unknown) => {
        sent.push(msg)
        return Promise.resolve()
      }),
    }

    const res = await app.request('/api/admin/heal-ai', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: mockQueue })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ queued: 1, cappedOut: 0, remaining: 0 })
    expect(sent).toHaveLength(1)
  })
})
