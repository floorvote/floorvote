import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../../test/helpers'
import { getDb } from '../db/client'
import { users } from '../db/schema'
import { inArray } from 'drizzle-orm'

vi.mock('../lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))
vi.mock('../cron/sync', () => ({ registerWithCentral: vi.fn().mockResolvedValue(undefined) }))

function mockQueue() {
  const batches: unknown[][] = []
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockImplementation((msgs: Iterable<unknown>) => {
      batches.push([...msgs])
      return Promise.resolve()
    }),
    _batches: batches,
  }
}

describe('POST /admin/members/bulk-invite', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
  })

  it('creates new users, classifies each row, and enqueues one job per created user', async () => {
    await seedUser({ role: 'member', email: 'taken@example.com', name: 'Taken' })
    const q = mockQueue()

    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'member',
        invitees: [
          { name: 'Jane', email: 'jane@example.com' },
          { email: 'taken@example.com' },
          { name: 'Dupe', email: 'jane@example.com' },
          { email: 'not-an-email' },
        ],
      }),
    }, { ...env, BILL_QUEUE: q })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.summary).toEqual({ invited: 1, exists: 1, duplicate: 1, invalid: 1 })

    const jane = body.results.find((r: any) => r.email === 'jane@example.com' && r.status === 'invited')
    expect(jane.userId).toBeTruthy()

    const db = getDb(env.DB)
    const row = await db.select().from(users).where(inArray(users.email, ['jane@example.com'])).get()
    expect(row?.role).toBe('member')
    expect(row?.name).toBe('Jane')

    const all = q._batches.flat() as any[]
    expect(all).toHaveLength(1)
    expect(all[0].body).toMatchObject({ type: 'invite-email', email: 'jane@example.com' })
  })

  it('inserts across the 20-row chunk boundary (45 rows -> all created)', async () => {
    const q = mockQueue()
    const invitees = Array.from({ length: 45 }, (_, i) => ({ email: `user${i}@example.com` }))
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member', invitees }),
    }, { ...env, BILL_QUEUE: q })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.summary.invited).toBe(45)

    const db = getDb(env.DB)
    const count = await db.select().from(users).where(
      inArray(users.email, invitees.map(i => i.email)),
    ).all()
    expect(count).toHaveLength(45)
  })

  it('rejects an oversized batch (>500)', async () => {
    const invitees = Array.from({ length: 501 }, (_, i) => ({ email: `u${i}@example.com` }))
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member', invitees }),
    }, { ...env, BILL_QUEUE: mockQueue() })
    expect(res.status).toBe(400)
  })

  it('returns 503 and creates no users when the queue is unbound', async () => {
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member', invitees: [{ email: 'x@example.com' }] }),
    }, { ...env, BILL_QUEUE: undefined })
    expect(res.status).toBe(503)

    const db = getDb(env.DB)
    const row = await db.select().from(users).where(inArray(users.email, ['x@example.com'])).get()
    expect(row).toBeUndefined()
  })

  it('is blocked by the demo read-only guard', async () => {
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member', invitees: [{ email: 'x@example.com' }] }),
    }, { ...env, BILL_QUEUE: mockQueue(), DEMO_MODE: 'true' })
    expect(res.status).toBe(403)
  })

  it('still succeeds and keeps the created users when enqueue fails', async () => {
    const failingQueue = {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockRejectedValue(new Error('transient queue 503')),
    }
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member', invitees: [{ email: 'pending@example.com' }] }),
    }, { ...env, BILL_QUEUE: failingQueue })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.summary.invited).toBe(1)

    // User row persists despite the failed enqueue — recoverable via resend-invite.
    const db = getDb(env.DB)
    const row = await db.select().from(users).where(inArray(users.email, ['pending@example.com'])).get()
    expect(row).toBeTruthy()
  })
})
