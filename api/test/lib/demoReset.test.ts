import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { calendarEvents, calendarEventBills, associationConfig, users, sessions, magicLinks, feedEvents, roles, customFieldDefinitions } from '../../src/db/schema'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS, resolveDemoSeed, type DemoSeed } from '../../src/lib/demoSeeds'
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
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
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

    await expect(runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])).resolves.toBeUndefined()

    // The join row referencing the wiped event must be gone too.
    const joins = await db.select().from(calendarEventBills).all()
    expect(joins.length).toBe(0)
  })

  // The browser namespaces its local mention read state on this value, so a
  // reset that does not move it leaves a laptop showing the seeded mentions read
  // forever — the bug this stamp exists to fix. Seeded mention ids are stable
  // across resets by design, so the epoch is the only thing that can change.
  it('stamps a demo_reset_at epoch that changes on every reset', async () => {
    const db = getDb(env.DB)
    const read = async () =>
      (await db.select().from(associationConfig).where(eq(associationConfig.key, 'demo_reset_at')).get())?.value

    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
    const first = await read()
    expect(first).toBeTruthy()

    // Date.now() has 1ms resolution and the two resets can land in the same
    // millisecond, so wait long enough that a changed value is meaningful.
    await new Promise((r) => setTimeout(r, 5))
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
    const second = await read()

    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
  })

  it('enables the calendar module in association config', async () => {
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
    const db = getDb(env.DB)
    const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'modules')).get()
    expect(row).toBeDefined()
    const modules = JSON.parse(row!.value) as Record<string, unknown>
    expect(modules['calendar']).toBe(true)
    expect(modules['upcoming-hearings']).toBe(false)
  })

  it('seeds an accepted invite + session for every persona so the member count matches the roster', async () => {
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
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
    // the nav dot for the first visitor after every reset. Seed it to now.
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
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
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
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
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
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
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
    const stray = await db.select().from(calendarEvents).where(eq(calendarEvents.id, 'stray')).get()
    expect(stray).toBeUndefined()
  })
})

const countRows = async (table: string): Promise<number> => {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>()
  return row?.n ?? 0
}

describe('runDemoReset with the nj-county-clerks seed', () => {
  const seed = DEMO_SEEDS['nj-county-clerks']

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('is registered', () => {
    expect(seed).toBeDefined()
    expect(seed.slug).toBe('nj-county-clerks')
  })

  it('defaults to nj-county-clerks when DEMO_SEED is unset', () => {
    // Demo tenants deployed before DEMO_SEED existed must keep working.
    expect(resolveDemoSeed(undefined)).toBe(seed)
    expect(resolveDemoSeed('nj-county-clerks')).toBe(seed)
    expect(() => resolveDemoSeed('no-such-seed')).toThrow(/Unknown DEMO_SEED/)
  })

  it('restores the canonical roster and static data', async () => {
    await runDemoReset(env.DB, seed)
    expect(await countRows('users')).toBe(15)
    expect(await countRows('roles')).toBe(5)
    expect(await countRows('custom_field_definitions')).toBe(5)
    // Every persona needs a session row and a used magic link or the sidebar
    // member count reads 0 despite a full Members page.
    expect(await countRows('sessions')).toBe(15)
    expect(await countRows('magic_links')).toBe(15)
  })

  it('writes the association config the UI reads', async () => {
    await runDemoReset(env.DB, seed)
    const row = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'association_name'`
    ).first<{ value: string }>()
    expect(JSON.parse(row!.value)).toContain('Demo — ')
  })

  it('writes the seed banner copy into config', async () => {
    await runDemoReset(env.DB, seed)
    const row = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'demo_banner'`
    ).first<{ value: string }>()
    expect(JSON.parse(row!.value)).toBe(seed.bannerText)
  })

  it('omits state_coverage for a single-state seed', async () => {
    // nj-county-clerks is a STATE = "NJ" tenant, so it carries no coverage list.
    expect(seed.stateCoverage).toBeNull()
    await runDemoReset(env.DB, seed)
    const row = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'state_coverage'`
    ).first()
    expect(row).toBeNull()
  })

  it('attaches engagement only to bills that exist', async () => {
    // Bill-linked inserts are INSERT ... SELECT guarded on the bill existing,
    // so with no bills seeded they must all no-op rather than throw.
    await runDemoReset(env.DB, seed)
    expect(await countRows('comments')).toBe(0)
    expect(await countRows('feed_events')).toBe(0)

    const first = seed.comments[0].externalId
    await seedBill({ externalId: first, billNumber: 'A1129', title: 'Drop boxes', state: 'NJ', priority: 'high' })
    await runDemoReset(env.DB, seed)
    expect(await countRows('comments')).toBeGreaterThan(0)
    expect(await countRows('feed_events')).toBeGreaterThan(0)
  })

  it('is idempotent', async () => {
    await runDemoReset(env.DB, seed)
    await runDemoReset(env.DB, seed)
    expect(await countRows('users')).toBe(15)
    expect(await countRows('roles')).toBe(5)
  })

  it('derives its keep-lists from the seed, not a hardcoded id list', async () => {
    // The "delete non-seed rows" steps used to hardcode the NJ ids, which would
    // make a second seed delete its own roster on every reset. Run a variant seed
    // whose roster, roles, and custom fields differ and check both directions.
    const variant: DemoSeed = {
      ...seed,
      users: [...seed.users, {
        id: 'other-user', email: 'other@demo.example', name: 'Other Persona',
        role: 'member', subtitle: 'Clerk · Elsewhere', createdDaysAgo: 5,
        canVote: true, lastActiveDaysAgo: 1,
      }],
      roles: [{ id: 'other-role', name: 'Other Role' }],
      userRoles: [{ userId: 'other-user', roleId: 'other-role' }],
      customFields: [{
        id: 'other-cf', name: 'Other Field', slug: 'other-field',
        type: 'text', options: null, displayOrder: 1,
      }],
      customFieldValues: [],
    }
    await runDemoReset(env.DB, variant)
    const db = getDb(env.DB)

    const roleIds = (await db.select().from(roles).all()).map((r) => r.id)
    expect(roleIds).toEqual(['other-role'])

    const fieldIds = (await db.select().from(customFieldDefinitions).all()).map((f) => f.id)
    expect(fieldIds).toEqual(['other-cf'])

    const userIds = (await db.select().from(users).all()).map((u) => u.id)
    expect(userIds).toContain('other-user')
    expect(userIds).toContain('demo-user')
    expect(userIds.length).toBe(16)
  })

  it('clears the triage latch so dismissed new matches come back', async () => {
    // triage-dismiss is an allowed demo write (DEMO_WRITE_ALLOWLIST) and it was
    // the one allowed write the reset could not undo: bills.triaged_at is what
    // removes a bill from the "New matches" worklist (newMatchWhere =
    // `triaged_at IS NULL`), and demoResetAndSeed only re-ingests bills when the
    // table is empty. So a visitor dismissing each match used to strip the triage
    // experience out of the demo for good.
    //
    // The latch is set by a direct D1 write rather than by calling
    // PATCH /bills/:id/triage-dismiss: the subject here is runDemoReset, which
    // takes a D1Database and no request context, and the route's own latching is
    // already pinned by test/routes/triageDismiss.test.ts. Going through the
    // route would only add an auth/router harness between the test and the two
    // columns it asserts on.
    const first = seed.comments[0].externalId
    const billId = await seedBill({
      externalId: first, billNumber: 'A1129', title: 'Drop boxes', state: 'NJ',
      matchType: 'keyword', newMatchAt: '2026-08-01 00:00:00',
    })
    await env.DB.prepare(
      `UPDATE bills SET triaged_at = '2026-08-02 00:00:00', triaged_by = 'demo-user' WHERE id = ?`
    ).bind(billId).run()

    const dismissed = await env.DB.prepare(
      `SELECT triaged_at AS at, triaged_by AS by FROM bills WHERE id = ?`
    ).bind(billId).first<{ at: string | null; by: string | null }>()
    // Guard the arrange step: if the latch never landed the assertion below would
    // pass for the wrong reason.
    expect(dismissed!.at).not.toBeNull()
    expect(dismissed!.by).toBe('demo-user')

    await runDemoReset(env.DB, seed)

    const after = await env.DB.prepare(
      `SELECT triaged_at AS at, triaged_by AS by FROM bills WHERE id = ?`
    ).bind(billId).first<{ at: string | null; by: string | null }>()
    expect(after!.at).toBeNull()
    expect(after!.by).toBeNull()
  })

  it('restores comment reactions', async () => {
    const first = seed.comments[0]
    await seedBill({ externalId: first.externalId, billNumber: 'A1129', title: 'Drop boxes', state: 'NJ', priority: 'high' })
    await runDemoReset(env.DB, seed)
    expect(seed.reactions.length).toBeGreaterThan(0)
    expect(await countRows('comment_reactions')).toBeGreaterThan(0)
  })
})
