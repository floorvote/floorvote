import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession, seedMagicLink, seedBill, seedCalendarEvent } from '../helpers'
import { getDb } from '../../src/db/client'
import { memberVotes, associationConfig, calendarEvents, users, bills } from '../../src/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { app } from '../../src/index'

describe('GET /stats/sidebar', () => {
  let memberId: string
  let memberToken: string

  beforeEach(async () => {
    await clearDb()
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
    await clearDb()
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
      { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(200)
    const body = await res.json() as { upcomingHearings: Array<{ date: string; bills: Array<{ billNumber: string }> }> }
    expect(body.upcomingHearings).toHaveLength(1)
    expect(body.upcomingHearings[0].date).toBe(dateFromNow(3))
    expect(body.upcomingHearings[0].bills[0].billNumber).toBe('A1129')
  })

  it('returns the seeded hearing without a successful central call in demo mode', async () => {
    const res = await app.request('/api/stats/sidebar',
      { headers: { Cookie: `session=${memberToken}` } },
      { ...env, DEMO_MODE: 'true' })
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
      { ...env, DEMO_MODE: 'true' })
    const body = await res.json() as { upcomingHearings: Array<{ bills: Array<{ billNumber: string }> }> }
    // Only the prioritized A1129 hearing remains; A2000 is filtered out.
    expect(body.upcomingHearings).toHaveLength(1)
    expect(body.upcomingHearings[0].bills.map(b => b.billNumber)).toEqual(['A1129'])
  })
})

describe('GET /stats/sidebar — upcoming hearings from central', () => {
  let memberToken: string

  const dateFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10)

  beforeEach(async () => {
    await clearDb()
    memberToken = await seedSession(await seedUser())

    const db = getDb(env.DB)
    await db.insert(associationConfig).values({
      key: 'modules',
      value: JSON.stringify({ 'upcoming-hearings': { enabled: true } }),
    })
    await seedBill({ externalId: 'legiscan:2099974', billNumber: 'A1129', title: 'Drop boxes', state: 'NJ', priority: 'high' })
  })

  it('loads hearings for a tenant with no PROVIDER setting', async () => {
    const requested: string[] = []
    const central = {
      fetch: async (req: Request) => {
        requested.push(new URL(req.url).pathname)
        return Response.json([{
          eventHash: 'eh1', type: 'Hearing', date: dateFromNow(3), time: '10:00:00',
          location: 'Room 11', description: 'Committee hearing',
          billId: 2099974, billNumber: 'A1129', billTitle: 'Drop boxes', state: 'NJ', sessionName: null,
        }])
      },
    }
    const { PROVIDER: _omit, ...envWithoutProvider } = env as typeof env & { PROVIDER?: string }
    expect(envWithoutProvider).not.toHaveProperty('PROVIDER')

    const res = await app.request('/api/stats/sidebar',
      { headers: { Cookie: `session=${memberToken}` } },
      { ...envWithoutProvider, CENTRAL: central } as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { upcomingHearings: Array<{ date: string; bills: Array<{ billNumber: string }> }> }
    expect(requested.some(p => p.endsWith('/upcoming-hearings'))).toBe(true)
    expect(body.upcomingHearings).toHaveLength(1)
    expect(body.upcomingHearings[0].date).toBe(dateFromNow(3))
    expect(body.upcomingHearings[0].bills[0].billNumber).toBe('A1129')
  })

  it.each(['legiscan:2099974', 'bill:2099974'])('lists the hearing of a priority bill stored as %s (#305)', async (stored) => {
    await getDb(env.DB).update(bills).set({ externalId: stored }).where(eq(bills.billNumber, 'A1129'))
    const central = {
      fetch: async () => Response.json([{
        eventHash: 'eh1', type: 'Hearing', kind: 'hearing', date: dateFromNow(3), time: '10:00:00', location: 'Room 11',
        description: 'Committee hearing', billId: 2099974, billNumber: 'A1129', billTitle: 'Drop boxes', state: 'NJ', sessionName: null,
      }]),
    }
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: `session=${memberToken}` } }, { ...env, CENTRAL: central } as never)
    const body = await res.json() as { upcomingHearings: Array<{ bills: Array<{ billNumber: string }> }> }
    expect(body.upcomingHearings.map(h => h.bills.map(b => b.billNumber))).toEqual([['A1129']])
  })

  it('lists the hearings of 60 distinct priority bills, past D1\'s 100-bind limit once each handle has two spellings (#305)', async () => {
    const numbers = Array.from({ length: 60 }, (_, i) => 4000 + i)
    for (const n of numbers) await seedBill({ externalId: n % 2 ? `bill:${n}` : `legiscan:${n}`, billNumber: `H${n}`, title: `Bill ${n}`, state: 'NJ', priority: 'high' })
    const central = {
      fetch: async () => Response.json(numbers.map(n => ({
        eventHash: `eh${n}`, type: 'Hearing', kind: 'hearing', date: dateFromNow(3), time: '10:00:00', location: `Room ${n}`,
        description: `Hearing ${n}`, billId: n, billNumber: `H${n}`, billTitle: `Bill ${n}`, state: 'NJ', sessionName: null,
      }))),
    }
    const res = await app.request('/api/stats/sidebar', { headers: { Cookie: `session=${memberToken}` } }, { ...env, CENTRAL: central } as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { upcomingHearings: Array<{ bills: Array<{ billNumber: string }> }> }
    expect(body.upcomingHearings.flatMap(h => h.bills.map(b => b.billNumber)).sort()).toEqual(numbers.map(n => `H${n}`).sort())
  })

  it('leaves out a deadline, which central sends with its own kind', async () => {
    const central = {
      fetch: async () => Response.json([
        { eventHash: 'eh1', type: 'Hearing', kind: 'hearing', date: dateFromNow(3), time: '10:00:00', location: 'Room 11',
          description: 'Committee hearing', billId: 2099974, billNumber: 'A1129', billTitle: 'Drop boxes', state: 'NJ', sessionName: null },
        { eventHash: 'eh2', type: 'Deadline', kind: 'deadline', date: dateFromNow(4), time: null, location: null,
          description: "Mayor's response due", billId: 2099974, billNumber: 'A1129', billTitle: 'Drop boxes', state: 'NJ', sessionName: null },
      ]),
    }
    const res = await app.request('/api/stats/sidebar',
      { headers: { Cookie: `session=${memberToken}` } },
      { ...env, CENTRAL: central } as never)
    const body = await res.json() as { upcomingHearings: Array<{ date: string }> }
    expect(body.upcomingHearings.map(h => h.date)).toEqual([dateFromNow(3)])
  })
})

describe('GET /api/stats memberCount', () => {
  let token: string
  beforeEach(async () => {
    await clearDb()
    // Requester: accepted (used magic link) + a live session so they can authenticate.
    const me = await seedUser({ email: 'me@b.com' })
    await seedMagicLink(me, { used: true })
    token = await seedSession(me)
  })

  it('counts accepted members regardless of a live session, and excludes invite-pending', async () => {
    const inviter = await seedUser({ email: 'inviter@b.com' }); await seedMagicLink(inviter, { used: true })
    // Two accepted members with NO live session (the "logged out / session booted" case) — must still count.
    const a = await seedUser({ email: 'a@b.com', invitedBy: inviter }); await seedMagicLink(a, { used: true })
    const b = await seedUser({ email: 'b@b.com', invitedBy: inviter }); await seedMagicLink(b, { used: true })
    // Invite pending: link issued but never used — must NOT count.
    const pending = await seedUser({ email: 'pending@b.com', invitedBy: inviter }); await seedMagicLink(pending, { used: false })

    const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const body = await r.json() as { memberCount: number }
    expect(body.memberCount).toBe(4) // me + inviter + a + b
  })

  it('counts a superadmin who signed in through central, who has no magic link and no inviter', async () => {
    // Central SSO creates the user with no inviter and signs them in with a session only.
    const superadmin = await seedUser({ email: 'super@central.com', role: 'admin', invitedBy: null })
    await seedSession(superadmin)

    const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
    const body = await r.json() as { memberCount: number }
    expect(body.memberCount).toBe(2) // me + superadmin
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

describe('GET /api/stats newMatchesCount', () => {
  let token: string
  beforeEach(async () => {
    await clearDb()
    token = await seedSession(await seedUser({ email: 'admin@b.com', role: 'admin' }))
  })

  // The dashboard's "N new" is the size of the triage worklist, and a companion group is one item on it.
  it('counts a companion group once', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', newMatchAt: '2026-03-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', newMatchAt: '2026-03-02 00:00:00' })
    await seedBill({ id: 'solo', billNumber: 'HB 1', newMatchAt: '2026-03-03 00:00:00' })
    await getDb(env.DB).update(bills).set({ groupKey: 'a190' }).where(inArray(bills.id, ['a190', 'b1713']))
    const r = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
    expect((await r.json() as { newMatchesCount: number }).newMatchesCount).toBe(2)
  })

  const chipAndList = async () => {
    const headers = { Cookie: `session=${token}` }
    const stats = await (await SELF.fetch('http://localhost/api/stats', { headers })).json() as { newMatchesCount: number }
    const list = await (await SELF.fetch('http://localhost/api/bills?newMatches=1', { headers })).json() as { bills: { group?: unknown[] }[]; pagination: { total: number } }
    return { chip: stats.newMatchesCount, total: list.pagination.total, rows: list.bills }
  }

  it('shows a group with two new-match members once in the new-matches view, as the chip counts it', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', matchType: 'keyword', newMatchAt: '2026-03-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', matchType: 'keyword', newMatchAt: '2026-03-02 00:00:00' })
    await getDb(env.DB).update(bills).set({ groupKey: 'a190' }).where(inArray(bills.id, ['a190', 'b1713']))
    const { chip, total, rows } = await chipAndList()
    expect([chip, total, rows.length]).toEqual([1, 1, 1])
    expect(rows[0].group).toHaveLength(2)
  })

  it('counts ungrouped new matches one each, in the chip and the view', async () => {
    await seedBill({ id: 'x1', billNumber: 'HB 1', matchType: 'keyword', newMatchAt: '2026-03-01 00:00:00' })
    await seedBill({ id: 'x2', billNumber: 'HB 2', matchType: 'keyword', newMatchAt: '2026-03-02 00:00:00' })
    const { chip, total, rows } = await chipAndList()
    expect([chip, total, rows.length]).toEqual([2, 2, 2])
  })
})

const isoDay = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10)

describe('GET /api/stats calendarUpcomingCount', () => {
  let token: string
  beforeEach(async () => {
    await clearDb()
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

// The web side (Sidebar's priority list, sidebar/HearingRow) picks the dashed
// BillBadge variant off `isDraft`, but its component tests build the sidebar
// objects by hand — so a dropped select column or a typo in the emit below
// would ship solid navy badges for drafts with a green web suite. That is the
// bug the dashed variant exists to fix, returning silently. These assert the
// wire payload itself.
describe('GET /stats/sidebar — priorityBills isDraft', () => {
  let memberToken: string

  beforeEach(async () => {
    await clearDb()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
  })

  async function priorityBills(): Promise<Array<Record<string, unknown>>> {
    const res = await SELF.fetch('http://localhost/api/stats/sidebar', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    return (await res.json() as { priorityBills: Array<Record<string, unknown>> }).priorityBills
  }

  it('emits isDraft: true for a prioritized draft bill', async () => {
    await seedBill({ billNumber: 'D 1', title: 'Draft Bill', priority: 'high', isDraft: true })
    const bill = (await priorityBills()).find(b => b.billNumber === 'D 1')
    expect(bill).toBeDefined()
    expect(bill!.isDraft).toBe(true)
  })

  // Explicitly `false`, not `undefined`. `isDraft` is required on the web
  // PriorityBill type, but an absent key would still render a solid badge and
  // therefore look correct — only a literal false proves the route read
  // bills.is_draft rather than omitting the column.
  it('emits isDraft: false — not undefined — for a filed bill', async () => {
    await seedBill({ billNumber: 'F 1', title: 'Filed Bill', priority: 'high', isDraft: false })
    const bill = (await priorityBills()).find(b => b.billNumber === 'F 1')
    expect(bill).toBeDefined()
    expect(bill!.isDraft).toBe(false)
    expect('isDraft' in bill!).toBe(true)
  })

  it('distinguishes the two within a single response', async () => {
    await seedBill({ billNumber: 'D 2', title: 'Draft Two', priority: 'high', isDraft: true })
    await seedBill({ billNumber: 'F 2', title: 'Filed Two', priority: 'low', isDraft: false })
    const all = await priorityBills()
    expect(all.find(b => b.billNumber === 'D 2')!.isDraft).toBe(true)
    expect(all.find(b => b.billNumber === 'F 2')!.isDraft).toBe(false)
  })
})
