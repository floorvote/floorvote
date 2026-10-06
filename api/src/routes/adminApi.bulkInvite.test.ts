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
  it('rejects addresses with trailing punctuation instead of storing them', async () => {
    const q = mockQueue()
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member', invitees: [{ name: 'Jane', email: 'jane@example.gov;' }, { email: 'bob@example.gov.' }] }),
    }, { ...env, BILL_QUEUE: q })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.summary).toEqual({ invited: 0, exists: 0, duplicate: 0, invalid: 2 })
    const db = getDb(env.DB)
    const rows = await db.select().from(users).where(inArray(users.email, ['jane@example.gov;', 'bob@example.gov.'])).all()
    expect(rows).toHaveLength(0)
    expect(q._batches.flat()).toHaveLength(0)
  })
})

// Pins what bulk invite reports for each address before its checks moved into
// the shared member-address helper. These must pass unchanged on both sides of
// that refactor.
describe('POST /admin/members/bulk-invite address checks', () => {
  let adminId: string
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin' })
    adminCookie = `session=${await seedSession(adminId)}`
  })

  async function bulkInvite(
    invitees: { name?: string; email?: string }[],
    q = mockQueue(),
    role: string = 'member',
  ) {
    const res = await app.request('/api/admin/members/bulk-invite', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, invitees }),
    }, { ...env, BILL_QUEUE: q })
    expect(res.status).toBe(200)
    return await res.json() as {
      summary: { invited: number; exists: number; duplicate: number; invalid: number }
      results: { email: string; status: string; userId?: string }[]
    }
  }

  async function allMembers() {
    return getDb(env.DB).select().from(users).all()
  }

  it('classifies a mixed batch row by row, in order, and creates only the invited members', async () => {
    const activeId = await seedUser({ email: 'active@example.com' })
    const deactivatedId = await seedUser({ email: 'gone@example.com', deactivatedAt: '2026-01-01 00:00:00' })
    await seedUser({ email: 'casey@example.com' })
    const before = await allMembers()
    const q = mockQueue()

    const body = await bulkInvite([
      { name: 'New One', email: 'new1@example.com' },
      { email: 'active@example.com' },
      { email: 'gone@example.com' },
      { email: '  CASEY@Example.COM  ' },
      { name: 'New Two', email: ' New2@Example.com ' },
      { email: 'new1@example.com' },
      { email: 'NEW2@example.com' },
      { email: 'not-an-email' },
      { email: '' },
      { email: '   ' },
      { name: 'No Email' },
      { email: 'jane@example.gov;' },
      { email: 'bob@example.gov.' },
      { email: '(pat@example.gov)' },
    ], q)

    expect(body.results.map(r => [r.email, r.status])).toEqual([
      ['new1@example.com', 'invited'],
      ['active@example.com', 'exists'],
      ['gone@example.com', 'exists'],
      ['casey@example.com', 'exists'],
      ['new2@example.com', 'invited'],
      ['new1@example.com', 'duplicate'],
      ['new2@example.com', 'duplicate'],
      ['not-an-email', 'invalid'],
      ['', 'invalid'],
      ['', 'invalid'],
      ['', 'invalid'],
      ['jane@example.gov;', 'invalid'],
      ['bob@example.gov.', 'invalid'],
      ['(pat@example.gov)', 'invalid'],
    ])
    expect(body.summary).toEqual({ invited: 2, exists: 3, duplicate: 2, invalid: 7 })

    // Only invited rows carry a userId, and it is the created member's id.
    for (const r of body.results) {
      if (r.status === 'invited') expect(r.userId).toBeTruthy()
      else expect(r.userId).toBeUndefined()
    }

    const after = await allMembers()
    expect(after).toHaveLength(before.length + 2)
    const created = after.filter(u => !before.some(b => b.id === u.id))
    expect(created.map(u => u.email).sort()).toEqual(['new1@example.com', 'new2@example.com'])
    for (const u of created) {
      expect(u.role).toBe('member')
      expect(u.invitedBy).toBe(adminId)
      expect(u.deactivatedAt).toBeNull()
      expect(body.results.find(r => r.status === 'invited' && r.email === u.email)?.userId).toBe(u.id)
    }
    expect(created.find(u => u.email === 'new1@example.com')?.name).toBe('New One')
    expect(created.find(u => u.email === 'new2@example.com')?.name).toBe('New Two')

    // Existing members, deactivated included, are left exactly as they were.
    const active = after.find(u => u.id === activeId)!
    const deactivated = after.find(u => u.id === deactivatedId)!
    expect(active).toEqual(before.find(u => u.id === activeId))
    expect(deactivated).toEqual(before.find(u => u.id === deactivatedId))
    expect(deactivated.deactivatedAt).toBeTruthy()

    const jobs = q._batches.flat() as any[]
    expect(jobs.map(j => j.body.email)).toEqual(['new1@example.com', 'new2@example.com'])
    expect(jobs.map(j => j.body.userId)).toEqual(
      body.results.filter(r => r.status === 'invited').map(r => r.userId),
    )
  })

  it('reports an existing member listed twice as exists, then duplicate', async () => {
    await seedUser({ email: 'active@example.com' })
    const body = await bulkInvite([
      { email: 'Active@example.com' },
      { email: 'active@example.com' },
    ])
    expect(body.results.map(r => r.status)).toEqual(['exists', 'duplicate'])
    expect(body.summary).toEqual({ invited: 0, exists: 1, duplicate: 1, invalid: 0 })
  })

  it('reports a repeated invalid address as invalid each time, not duplicate', async () => {
    const body = await bulkInvite([
      { email: 'jane@example.gov;' },
      { email: 'jane@example.gov;' },
    ])
    expect(body.results.map(r => r.status)).toEqual(['invalid', 'invalid'])
  })

  it('reports a deactivated member as exists and does not reactivate or re-invite them', async () => {
    const id = await seedUser({ email: 'gone@example.com', deactivatedAt: '2026-01-01 00:00:00' })
    const q = mockQueue()
    const body = await bulkInvite([{ email: 'GONE@example.com' }], q)
    expect(body.results).toEqual([{ email: 'gone@example.com', status: 'exists' }])
    const row = (await allMembers()).find(u => u.id === id)!
    expect(row.deactivatedAt).toBeTruthy()
    expect(q._batches.flat()).toHaveLength(0)
  })

  it('stores the address lowercased and trimmed, and the name trimmed to 100 characters', async () => {
    const body = await bulkInvite([{ name: `  ${'x'.repeat(150)}  `, email: '  Mixed.Case@Example.ORG ' }], mockQueue(), 'admin')
    expect(body.results).toEqual([{ email: 'mixed.case@example.org', status: 'invited', userId: expect.any(String) }])
    const row = (await allMembers()).find(u => u.id === body.results[0].userId)!
    expect(row.email).toBe('mixed.case@example.org')
    expect(row.name).toBe('x'.repeat(100))
    expect(row.role).toBe('admin')
  })

  it('finds existing members across a batch larger than one lookup can bind', async () => {
    // D1 caps a query at 100 bound parameters, so a 150-address batch has to
    // be looked up in more than one query.
    for (const i of [0, 99, 149]) await seedUser({ email: `big${i}@example.com` })
    const invitees = Array.from({ length: 150 }, (_, i) => ({ email: `big${i}@example.com` }))
    const body = await bulkInvite(invitees)
    expect(body.summary).toEqual({ invited: 147, exists: 3, duplicate: 0, invalid: 0 })
    expect(body.results.filter(r => r.status === 'exists').map(r => r.email))
      .toEqual(['big0@example.com', 'big99@example.com', 'big149@example.com'])
  })
})
