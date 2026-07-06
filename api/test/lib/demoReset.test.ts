import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { calendarEvents, calendarEventBills, associationConfig, users, sessions, magicLinks, feedEvents } from '../../src/db/schema'
import { runDemoReset } from '../../src/lib/demoReset'
import { eq, count, exists, and, isNull, isNotNull } from 'drizzle-orm'

const today = () => new Date().toISOString().slice(0, 10)
const dateFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10)

describe('runDemoReset — calendar seeding', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    // Seed the priority bills the reset attaches hearings/custom events to.
    await seedBill({ externalId: 'legiscan:2099974', billNumber: 'A1129', title: 'Drop boxes', state: 'NJ' })
    await seedBill({ externalId: 'legiscan:2100182', billNumber: 'A1195', title: 'Voter Convenience', state: 'NJ' })
  })

  it('seeds hearing and custom events, with at least one of each in the next 30 days', async () => {
    await runDemoReset(env.DB)
    const db = getDb(env.DB)
    const rows = await db.select().from(calendarEvents).all()

    const hearings = rows.filter((r) => r.source === 'hearing')
    const customs = rows.filter((r) => r.source === 'custom')
    expect(hearings.length).toBeGreaterThan(0)
    expect(customs.length).toBeGreaterThan(0)

    const inNext30 = (d: string | null) => d != null && d >= today() && d <= dateFromNow(30)
    expect(hearings.some((r) => inNext30(r.date))).toBe(true)
    expect(customs.some((r) => inNext30(r.date))).toBe(true)
    // Hearings are tied to a bill; at least one resolved to a seeded bill.
    expect(hearings.some((r) => r.billId != null)).toBe(true)
  })

  it('clears calendar_event_bills before calendar_events (no FK-constraint failure)', async () => {
    // Repro for the prod demo-reset failure: calendar_event_bills.event_id
    // REFERENCES calendar_events(id) with NO cascade (migration 0045). With any
    // join row present, "DELETE FROM calendar_events" violates the FK and rolls
    // back the entire reset — which is why demo data froze on 2026-06-04.
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({
      id: 'linked-evt', uid: 'linked@test', billId: null, source: 'custom', sequence: 0,
      date: dateFromNow(3), time: null, location: null, description: 'linked', status: 'confirmed', eventHash: null,
    })
    await db.insert(calendarEventBills).values({ eventId: 'linked-evt', billId: 'legiscan:2099974' })

    await expect(runDemoReset(env.DB)).resolves.toBeUndefined()

    // The join row referencing the wiped event must be gone too.
    const joins = await db.select().from(calendarEventBills).all()
    expect(joins.length).toBe(0)
  })

  it('enables the calendar module in association config', async () => {
    await runDemoReset(env.DB)
    const db = getDb(env.DB)
    const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'modules')).get()
    expect(row).toBeDefined()
    const modules = JSON.parse(row!.value) as Record<string, unknown>
    expect(modules['calendar']).toBe(true)
    expect(modules['upcoming-hearings']).toBe(false)
  })

  it('seeds an accepted invite + session for every persona so the member count matches the roster', async () => {
    await runDemoReset(env.DB)
    const db = getDb(env.DB)

    // Full roster (matches GET /users and engagement total_members).
    const total = await db.select({ count: count() }).from(users).get()

    // Sidebar member count (stats.ts): users who accepted their invite (used a
    // magic link) and are not deactivated — NOT keyed on an ephemeral session
    // row. Demo personas never go through the magic-link flow, so the reset must
    // seed a used magic_link per persona or the sidebar reports "0 members"
    // while the roster shows the full list.
    const accepted = await db
      .select({ count: count() })
      .from(users)
      .where(and(
        isNull(users.deactivatedAt),
        exists(db.select({ id: magicLinks.id }).from(magicLinks).where(and(
          eq(magicLinks.userId, users.id),
          isNotNull(magicLinks.usedAt),
        ))),
      ))
      .get()

    // Active-members curve (engagement dashboard) still needs a session per persona.
    const withSession = await db
      .select({ count: count() })
      .from(users)
      .where(exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))))
      .get()

    expect(total?.count).toBeGreaterThan(1)
    // Every seeded persona must register as an accepted member AND have a session.
    expect(accepted?.count).toBe(total?.count)
    expect(withSession?.count).toBe(total?.count)
  })

  it('marks demo-user as having seen the feed so the Pulse nav dot stays dark', async () => {
    // The reset re-creates demo-user (INSERT OR REPLACE) and seeds feed events with
    // past timestamps. Without a seen baseline, last_seen_feed is null, which lights
    // the nav dot for the first visitor after every nightly reset. Seed it to now.
    await runDemoReset(env.DB)
    const db = getDb(env.DB)
    const demoUser = await db.select().from(users).where(eq(users.id, 'demo-user')).get()
    expect(demoUser).toBeDefined()
    expect(demoUser!.lastSeenFeed).not.toBeNull()
    expect(demoUser!.lastSeenFeed!).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('seeds time-offset bill_updated activity so the feed shows more than comments', async () => {
    // The demo feed used to surface almost nothing but comments because the only
    // non-comment events seeded were priority/position/vote — there was no
    // legislative bill activity. Seed bill_updated events (status changes, actions,
    // votes, amendments) spread across the recent window, the way calendar
    // hearings are seeded relative to now.
    await runDemoReset(env.DB)
    const db = getDb(env.DB)

    const updates = await db
      .select()
      .from(feedEvents)
      .where(eq(feedEvents.type, 'bill_updated'))
      .all()
    expect(updates.length).toBeGreaterThan(0)

    // Each event carries a non-empty changes array of well-formed ChangeRecords.
    for (const ev of updates) {
      const meta = JSON.parse(ev.metadata) as { changes?: Array<{ changeType?: string }> }
      expect(Array.isArray(meta.changes)).toBe(true)
      expect(meta.changes!.length).toBeGreaterThan(0)
      expect(meta.changes!.every((c) => typeof c.changeType === 'string' && c.changeType)).toBe(true)
      // Timestamps are SQLite space-format UTC (sortable alongside other events).
      expect(ev.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    }

    // At least one update is recent (within ~2 weeks) so fresh activity tops the feed.
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
    expect(updates.some((ev) => ev.createdAt >= twoWeeksAgo)).toBe(true)
  })

  it('co-dates activity and comments so the top feed cards show a mix of both', async () => {
    // The feed groups by bill+day and orders cards by their most recent event. To
    // keep the *top* cards from being activity-only, each top bill's freshest
    // bill_updated event must share a day with a comment_added event on the same
    // bill — so the card renders legislative activity AND discussion together.
    // Seed the four high-priority bills whose freshest activity is co-dated with a
    // comment (beforeEach only seeds two).
    await seedBill({ externalId: 'legiscan:2098113', billNumber: 'A1715', title: 'John R. Lewis Act', state: 'NJ' })
    await seedBill({ externalId: 'legiscan:2098535', billNumber: 'A1680', title: 'Voter registration', state: 'NJ' })
    await runDemoReset(env.DB)
    const db = getDb(env.DB)

    const rows = await db
      .select({ billId: feedEvents.billId, type: feedEvents.type, createdAt: feedEvents.createdAt })
      .from(feedEvents)
      .all()

    // Group by bill + calendar day, mirroring groupEventsByBillAndDay.
    const groups = new Map<string, { latest: string; types: Set<string> }>()
    for (const r of rows) {
      const day = r.createdAt.slice(0, 10)
      const key = `${r.billId}::${day}`
      const g = groups.get(key) ?? { latest: r.createdAt, types: new Set<string>() }
      g.types.add(r.type)
      if (r.createdAt > g.latest) g.latest = r.createdAt
      groups.set(key, g)
    }

    // Top cards = most recent groups. The three freshest must each mix bill
    // activity with a comment (older standalone comments may follow lower down).
    const top = [...groups.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1)).slice(0, 3)
    expect(top.length).toBe(3)
    for (const g of top) {
      expect(g.types.has('bill_updated')).toBe(true)
      expect(g.types.has('comment_added')).toBe(true)
    }
  })

  it('clears calendar_events on reset (idempotent re-run leaves no stale custom rows)', async () => {
    const db = getDb(env.DB)
    await db.insert(calendarEvents).values({
      id: 'stray', uid: 'stray@test', billId: null, source: 'custom', sequence: 0,
      date: dateFromNow(2), time: null, location: null, description: 'stray', status: 'confirmed', eventHash: null,
    })
    await runDemoReset(env.DB)
    const stray = await db.select().from(calendarEvents).where(eq(calendarEvents.id, 'stray')).get()
    expect(stray).toBeUndefined()
  })
})
