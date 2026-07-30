import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents, users } from '../../src/db/schema'

describe('GET /feed', () => {
  let memberId: string
  let memberToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ name: 'Alice', subtitle: 'County Clerk, Ingham County' })
    memberToken = await seedSession(memberId)
    billId = await seedBill({ billNumber: 'HB 42', title: 'Election Security Act' })
    const db = getDb(env.DB)
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'comment_added',
      billId,
      userId: memberId,
      metadata: JSON.stringify({ preview: 'This is important.' }),
      createdAt: '2026-01-01T10:00:00Z',
    })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'bill_added',
      billId,
      userId: memberId,
      metadata: '{}',
      createdAt: '2026-01-01T09:00:00Z',
    })
  })

  it('returns 401 without session', async () => {
    const res = await SELF.fetch('http://localhost/api/feed')
    expect(res.status).toBe(401)
  })

  it('returns events newest first with bill and user info', async () => {
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { events: unknown[]; total: number }
    expect(body.events).toHaveLength(2)
    const first = body.events[0] as Record<string, unknown>
    expect(first.type).toBe('comment_added')
    expect(first.billNumber).toBe('HB 42')
    expect(first.billTitle).toBe('Election Security Act')
    expect(first.userName).toBe('Alice')
    expect(first.userSubtitle).toBe('County Clerk, Ingham County')
    expect(typeof first.metadata).toBe('object')
  })

  it('prefers bill title over abstract for billTitle', async () => {
    const db = getDb(env.DB)
    const billWithBoth = await seedBill({
      billNumber: 'SB 1383',
      title: 'SAVE America Act',
      abstract: 'A bill to establish the Veterans Advisory Committee, and for other purposes.',
    })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'bill_added',
      billId: billWithBoth,
      userId: memberId,
      metadata: '{}',
      createdAt: '2026-01-01T12:00:00Z',
    })

    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { events: Array<Record<string, unknown>> }
    const event = body.events.find((e) => e.billNumber === 'SB 1383')
    expect(event).toBeDefined()
    expect(event!.billTitle).toBe('SAVE America Act')
  })

  it('paginates with page and limit params', async () => {
    const res = await SELF.fetch('http://localhost/api/feed?page=1&limit=1', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { events: unknown[]; total: number; page: number; limit: number }
    expect(body.events).toHaveLength(1)
    expect(body.total).toBe(2)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(1)
  })

  it('excludes suppressed events', async () => {
    const db = getDb(env.DB)
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'position_set',
      billId,
      userId: memberId,
      metadata: '{}',
      suppressed: true,
      createdAt: '2026-01-01T08:00:00Z',
    })

    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { events: unknown[]; total: number }
    expect(body.total).toBe(2)
    const types = (body.events as Array<{ type: string }>).map((e) => e.type)
    expect(types).not.toContain('position_set')
  })

  it('includes bill_updated events from system user', async () => {
    const db = getDb(env.DB)
    // Priority bill so this passive provider update is visible in the default feed.
    const priorityBill = await seedBill({ billNumber: 'A 900', title: 'Tracked', priority: 'high' })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'bill_updated',
      billId: priorityBill,
      userId: 'system',
      metadata: JSON.stringify({ changes: ['status'], newStatus: '2', oldStatus: '1' }),
      createdAt: '2026-01-01T11:00:00Z',
    })

    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { events: Array<Record<string, unknown>>; total: number }
    const updated = body.events.find((e) => e.type === 'bill_updated')
    expect(updated).toBeDefined()
    expect(updated!.userName).toBeNull()
  })

  it('orders the feed page newest-first across mixed timestamp formats', async () => {
    const db = getDb(env.DB)
    const mixedBillId = await seedBill({ billNumber: 'H 7', title: 'Mixed Format Bill' })

    // ISO row at 09:00 (earlier). Explicit ISO createdAt — the legacy bad shape.
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'position_set', billId: mixedBillId, userId: memberId,
      metadata: JSON.stringify({ position: 'Support' }),
      createdAt: '2026-06-06T09:00:00.000Z',
    })
    // Space-format row at 14:00 (later). Explicit space-format value.
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'priority_set', billId: mixedBillId, userId: memberId,
      metadata: JSON.stringify({ priority: 'high' }),
      createdAt: '2026-06-06 14:00:00',
    })

    const res = await SELF.fetch('http://localhost/api/feed?limit=20', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { events: Array<{ type: string }> }
    // 14:00 priority_set must come before 09:00 position_set despite " " < "T".
    const mixed = body.events.filter((e) => e.type === 'priority_set' || e.type === 'position_set')
    expect(mixed.map((e) => e.type)).toEqual(['priority_set', 'position_set'])
  })

  it('includes billMatchType from the bill row', async () => {
    const db = getDb(env.DB)
    // The bill seeded in beforeEach has matchType 'keyword' by default.
    // Seed a second bill with matchType null to test both values appear.
    const nullMatchBillId = await seedBill({ billNumber: 'SB 99', title: 'Voter ID Act', matchType: null })
    // Non-passive event so it's visible in the default feed regardless of priority.
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(),
      type: 'bill_added',
      billId: nullMatchBillId,
      userId: memberId,
      metadata: '{}',
      createdAt: '2026-01-01T12:00:00Z',
    })

    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { events: Array<Record<string, unknown>> }
    const nullEvent = body.events.find((e) => e.billNumber === 'SB 99')
    expect(nullEvent).toBeDefined()
    expect(nullEvent!.billMatchType).toBeNull()

    const defaultEvent = body.events.find((e) => e.billNumber === 'HB 42')
    expect(defaultEvent).toBeDefined()
    expect(defaultEvent!.billMatchType).toBe('keyword')
  })

  it('excludes passive updates on non-priority bills from the default feed', async () => {
    const db = getDb(env.DB)
    const nonPriorityBill = await seedBill({ billNumber: 'A 100', title: 'Quiet bill', priority: null, matchType: 'keyword' })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'bill_updated', billId: nonPriorityBill, userId: 'system',
      metadata: '{}', createdAt: '2026-05-05T10:00:00Z',
    })
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { events: Array<{ billNumber: string }>; total: number }
    // Only the two beforeEach engagement events (on HB 42) survive; the passive
    // bill_updated on the non-priority bill is filtered server-side so it can't
    // consume a page slot the client would just cull.
    expect(body.events.find((e) => e.billNumber === 'A 100')).toBeUndefined()
    expect(body.total).toBe(2)
  })

  it('includes passive updates on priority bills in the default feed', async () => {
    const db = getDb(env.DB)
    const priorityBill = await seedBill({ billNumber: 'A 300', title: 'Tracked bill', priority: 'high' })
    await db.insert(feedEvents).values({
      id: crypto.randomUUID(), type: 'bill_updated', billId: priorityBill, userId: 'system',
      metadata: '{}', createdAt: '2026-05-05T10:00:00Z',
    })
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { events: Array<{ billNumber: string }> }
    expect(body.events.find((e) => e.billNumber === 'A 300')).toBeDefined()
  })
})

describe('POST /feed/seen', () => {
  let memberId: string
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ name: 'Bob' })
    memberToken = await seedSession(memberId)
  })

  it('returns 401 without session', async () => {
    const res = await SELF.fetch('http://localhost/api/feed/seen', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('sets last_seen_feed on the user and returns 204', async () => {
    // last_seen_feed is stored in SQLite space format ("YYYY-MM-DD HH:MM:SS").
    const before = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ')
    const res = await SELF.fetch('http://localhost/api/feed/seen', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(204)

    const db = getDb(env.DB)
    const user = await db.select().from(users).where(eq(users.id, memberId)).get()
    expect(user!.lastSeenFeed).not.toBeNull()
    expect(user!.lastSeenFeed!).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(user!.lastSeenFeed! >= before).toBe(true)
  })
})

describe('GET /feed latestEventAt', () => {
  let memberToken: string
  let memberId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ name: 'Carol' })
    memberToken = await seedSession(memberId)
  })

  it('returns null latestEventAt when feed is empty', async () => {
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { latestEventAt: string | null }
    expect(body.latestEventAt).toBeNull()
  })

  it('returns the most recent event createdAt as latestEventAt', async () => {
    const db = getDb(env.DB)
    const billId = await seedBill({ billNumber: 'HB 1', title: 'Test' })
    const memberId2 = await seedUser({ name: 'Dave' })
    await db.insert(feedEvents).values([
      { id: crypto.randomUUID(), type: 'bill_added', billId, userId: memberId2, metadata: '{}', createdAt: '2026-01-01T10:00:00Z' },
      { id: crypto.randomUUID(), type: 'bill_added', billId, userId: memberId2, metadata: '{}', createdAt: '2026-01-02T10:00:00Z' },
    ])
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { latestEventAt: string | null }
    // max(datetime(...)) normalizes to SQLite space format (same UTC instant);
    // the client parses it via dbTsToEpoch.
    expect(body.latestEventAt).toBe('2026-01-02 10:00:00')
  })

  it("ignores the current user's own events when computing latestEventAt", async () => {
    const db = getDb(env.DB)
    const billId = await seedBill({ billNumber: 'HB 5', title: 'Test' })
    const other = await seedUser({ name: 'Erin' })
    await db.insert(feedEvents).values([
      // another user's event (older) — should drive latestEventAt
      { id: crypto.randomUUID(), type: 'bill_added', billId, userId: other, metadata: '{}', createdAt: '2026-01-01T10:00:00Z' },
      // current user's own event (newer) — must be ignored
      { id: crypto.randomUUID(), type: 'priority_set', billId, userId: memberId, metadata: '{}', createdAt: '2026-01-03T10:00:00Z' },
    ])
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { latestEventAt: string | null }
    // max(datetime(...)) normalizes to SQLite space format (same UTC instant).
    expect(body.latestEventAt).toBe('2026-01-01 10:00:00')
  })

  it("returns null latestEventAt when the only events are the current user's own", async () => {
    const db = getDb(env.DB)
    const billId = await seedBill({ billNumber: 'HB 6', title: 'Test' })
    await db.insert(feedEvents).values([
      { id: crypto.randomUUID(), type: 'priority_set', billId, userId: memberId, metadata: '{}', createdAt: '2026-01-02T10:00:00Z' },
    ])
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { latestEventAt: string | null }
    expect(body.latestEventAt).toBeNull()
  })

  it('ignores passive updates on non-priority bills (matches the default feed filter)', async () => {
    const db = getDb(env.DB)
    const other = await seedUser({ name: 'Frank' })
    // A non-priority keyword bill with only a passive system bill_updated event (newer).
    const nonPriorityBill = await seedBill({ billNumber: 'A 100', title: 'Quiet bill', priority: null, matchType: 'keyword' })
    // A priority bill whose newest event is a human comment (older).
    const priorityBill = await seedBill({ billNumber: 'A 200', title: 'Loud bill', priority: 'high' })
    await db.insert(feedEvents).values([
      { id: crypto.randomUUID(), type: 'bill_updated', billId: nonPriorityBill, userId: 'system', metadata: '{}', createdAt: '2026-02-02T10:00:00Z' },
      { id: crypto.randomUUID(), type: 'comment_added', billId: priorityBill, userId: other, metadata: '{}', createdAt: '2026-02-01T10:00:00Z' },
    ])
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { latestEventAt: string | null }
    // The newer passive update on a non-priority bill is hidden from the default
    // feed, so it must not light the nav dot. The visible comment drives latestEventAt.
    expect(body.latestEventAt).toBe('2026-02-01 10:00:00')
  })

  it('counts passive updates on priority bills', async () => {
    const db = getDb(env.DB)
    const priorityBill = await seedBill({ billNumber: 'A 300', title: 'Tracked bill', priority: 'medium' })
    await db.insert(feedEvents).values([
      { id: crypto.randomUUID(), type: 'bill_updated', billId: priorityBill, userId: 'system', metadata: '{}', createdAt: '2026-03-03T10:00:00Z' },
    ])
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { latestEventAt: string | null }
    // Passive update on a priority bill IS visible in the default feed, so it lights the dot.
    expect(body.latestEventAt).toBe('2026-03-03 10:00:00')
  })

  it('counts engagement events even on non-priority bills', async () => {
    const db = getDb(env.DB)
    const other = await seedUser({ name: 'Heidi' })
    const nonPriorityBill = await seedBill({ billNumber: 'A 400', title: 'Active bill', priority: null, matchType: 'keyword' })
    await db.insert(feedEvents).values([
      { id: crypto.randomUUID(), type: 'comment_added', billId: nonPriorityBill, userId: other, metadata: '{}', createdAt: '2026-04-04T10:00:00Z' },
    ])
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { latestEventAt: string | null }
    // A human engagement event surfaces the group in the default feed, so it lights the dot.
    expect(body.latestEventAt).toBe('2026-04-04 10:00:00')
  })

  it('returns null lastSeenFeed before the user has marked the feed seen', async () => {
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { lastSeenFeed: string | null }
    expect(body.lastSeenFeed).toBeNull()
  })

  it("echoes the user's lastSeenFeed so other windows can clear the dot", async () => {
    // Mark seen, then read /feed as the same user — the response must carry the
    // freshly-stored baseline that another open window's poll will adopt.
    await SELF.fetch('http://localhost/api/feed/seen', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}` },
    })
    const res = await SELF.fetch('http://localhost/api/feed', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { lastSeenFeed: string | null }
    expect(body.lastSeenFeed).not.toBeNull()
    expect(body.lastSeenFeed!).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})
