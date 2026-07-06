import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedMagicLink, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { memberVotes, associationConfig, calendarEvents, users } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'

describe('GET /stats/sidebar', () => {
  let memberId: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
  })

  it('returns 401 when not authenticated', async () => {
    const res = await SELF.fetch('http://localhost/api/stats/sidebar')
    expect(res.status).toBe(401)
  })

  it('returns sidebar data with correct counts', async () => {
    const db = getDb(env.DB)

    // Seed 1 priority bill with tags
    const priorityBillId = await seedBill({
      billNumber: 'HB 10',
      title: 'Election Admin Act',
      priority: 'high',
      tags: ['Election Admin', 'Voting Rights'],
      session: '2026',
    })

    // Seed 1 non-priority bill
    await seedBill({ billNumber: 'SB 20', title: 'Other Bill', priority: null })

    // Seed 1 member vote (support) on the priority bill
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(),
      userId: memberId,
      billId: priorityBillId,
      position: 'support',
    })

    const res = await SELF.fetch('http://localhost/api/stats/sidebar', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)

    const body = await res.json() as {
      priorityBillCount: number
      unvotedPriorityCount: number
      upcomingHearings: Array<{ billNumber: string; type: string }>
      priorityBills: Array<{ id: string; billNumber: string; priority: string; myVote: string | null }>
    }

    expect(body.priorityBillCount).toBe(1)
    expect(body.unvotedPriorityCount).toBe(0)
    expect(Array.isArray(body.upcomingHearings)).toBe(true)
    expect(body.priorityBills).toHaveLength(1)
    expect(body.priorityBills[0].billNumber).toBe('HB 10')
    expect(body.priorityBills[0].priority).toBe('high')
    expect(body.priorityBills[0].myVote).toBe('support')
  })
})

describe('GET /stats/sidebar — DEMO_MODE upcoming hearings', () => {
  let memberId: string
  let memberToken: string

  const dateFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10)

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)

    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'modules',
      value: JSON.stringify({ 'upcoming-hearings': { enabled: true } }),
    })
    const billId = await seedBill({ externalId: 'legiscan:2099974', billNumber: 'A1129', title: 'Drop boxes', state: 'NJ', priority: 'high' })
    await db.insert(calendarEvents).values({
      id: 'h1', uid: 'h1@test', billId, source: 'hearing', sequence: 0,
      date: dateFromNow(3), time: '10:00:00', location: 'Room 11', description: 'Committee hearing',
      status: 'confirmed', eventHash: 'eh1',
    })
  })

  it('reads seeded calendar_events instead of central when DEMO_MODE=true', async () => {
    const res = await app.request('/api/stats/sidebar',
      { headers: { Cookie: `session=${memberToken}` } },
      { ...env, DEMO_MODE: 'true', PROVIDER: 'legiscan' })
    expect(res.status).toBe(200)
    const body = await res.json() as { upcomingHearings: Array<{ date: string; bills: Array<{ billNumber: string }> }> }
    expect(body.upcomingHearings).toHaveLength(1)
    expect(body.upcomingHearings[0].date).toBe(dateFromNow(3))
    expect(body.upcomingHearings[0].bills[0].billNumber).toBe('A1129')
  })

  it('returns the seeded hearing without a successful central call in demo mode', async () => {
    const res = await app.request('/api/stats/sidebar',
      { headers: { Cookie: `session=${memberToken}` } },
      { ...env, DEMO_MODE: 'true', PROVIDER: 'legiscan' })
    const body = await res.json() as { upcomingHearings: unknown[] }
    expect(body.upcomingHearings).toHaveLength(1)
  })

  it('excludes hearings for non-prioritized bills (scope is fixed to prioritized bills)', async () => {
    const db = getDb(env.DB)
    // A hearing on a bill with no priority must never surface in the widget.
    const plainBillId = await seedBill({ externalId: 'legiscan:3000001', billNumber: 'A2000', title: 'Unrelated', state: 'NJ', priority: null })
    await db.insert(calendarEvents).values({
      id: 'h2', uid: 'h2@test', billId: plainBillId, source: 'hearing', sequence: 0,
      date: dateFromNow(4), time: '11:00:00', location: 'Room 12', description: 'Other hearing',
      status: 'confirmed', eventHash: 'eh2',
    })
    const res = await app.request('/api/stats/sidebar',
      { headers: { Cookie: `session=${memberToken}` } },
      { ...env, DEMO_MODE: 'true', PROVIDER: 'legiscan' })
    const body = await res.json() as { upcomingHearings: Array<{ bills: Array<{ billNumber: string }> }> }
    // Only the prioritized A1129 hearing remains; A2000 is filtered out.
    expect(body.upcomingHearings).toHaveLength(1)
    expect(body.upcomingHearings[0].bills.map(b => b.billNumber)).toEqual(['A1129'])
  })
})

describe('GET /api/stats memberCount', () => {
  let token: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    // Requester: accepted (used magic link) + a live session so they can authenticate.
    const me = await seedUser({ email: 'me@b.com' })
    await seedMagicLink(me, { used: true })
    token = await seedSession(me)
  })

  it('counts accepted members regardless of a live session, and excludes invite-pending', async () => {
    // Two accepted members with NO live session (the "logged out / session booted" case) — must still count.
    const a = await seedUser({ email: 'a@b.com' }); await seedMagicLink(a, { used: true })
    const b = await seedUser({ email: 'b@b.com' }); await seedMagicLink(b, { used: true })
    // Invite pending: link issued but never used — must NOT count.
    const pending = await seedUser({ email: 'pending@b.com' }); await seedMagicLink(pending, { used: false })
    // A session but no accepted invite (e.g. stale row) — must NOT count under the accepted definition.
    const sessionOnly = await seedUser({ email: 'session@b.com' }); await seedSession(sessionOnly)

    const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const body = await r.json() as { memberCount: number }
    expect(body.memberCount).toBe(3) // me + a + b
  })

  it('excludes deactivated members even when they have accepted', async () => {
    const active = await seedUser({ email: 'active@b.com' }); await seedMagicLink(active, { used: true })
    const gone = await seedUser({ email: 'gone@b.com' }); await seedMagicLink(gone, { used: true })
    const db = getDb(env.DB)
    await db.update(users).set({ deactivatedAt: new Date().toISOString() }).where(eq(users.id, gone))

    const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
    const body = await r.json() as { memberCount: number }
    expect(body.memberCount).toBe(2) // me + active; gone is excluded
  })
})

const isoDay = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10)

describe('GET /api/stats calendarUpcomingCount', () => {
  let token: string
  beforeEach(async () => {
    await resetDb(); await applyMigrations()
    const uid = await seedUser({ email: 'a@b.com' }); token = await seedSession(uid)
    const prio = await seedBill({ billNumber: 'H 1', state: 'RI', session: '2026', priority: 'high' })
    const plain = await seedBill({ billNumber: 'H 2', state: 'RI', session: '2026' })
    // counts: priority hearing in-window
    await seedCalendarEvent(prio, { uid: 'h-in@t', date: isoDay(5) })
    // excluded: non-priority hearing
    await seedCalendarEvent(plain, { uid: 'h-plain@t', date: isoDay(5) })
    // excluded: out-of-window (>30d)
    await seedCalendarEvent(prio, { uid: 'h-far@t', date: isoDay(40) })
    // excluded: cancelled
    await seedCalendarEvent(prio, { uid: 'h-cancel@t', date: isoDay(6), status: 'cancelled' })
    // included: custom event in-window (no bill)
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(), uid: 'c-in@t', billId: null, source: 'custom',
      sequence: 0, date: isoDay(7), time: null, location: null, description: 'Mtg', status: 'confirmed', eventHash: null,
    })
  })

  it('counts confirmed priority hearings + custom events within 30 days', async () => {
    const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const body = await r.json() as { billCount: number; calendarUpcomingCount: number }
    expect(body.calendarUpcomingCount).toBe(2) // h-in + c-in only
  })

  it('returns the calendar upcoming window in days', async () => {
    const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
    const body = await r.json() as { calendarUpcomingDays: number }
    expect(body.calendarUpcomingDays).toBe(30)
  })
})
