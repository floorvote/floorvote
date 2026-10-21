import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { processCentralNotification } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { bills, calendarEvents, feedEvents } from '../../src/db/schema'
import { groupByHand } from '../../src/lib/companionGroups'
import { newMatchWhere } from '../../src/lib/newMatch'
import { PRIORITY_COLORS } from '../../../shared/billChipColors'
import { runWeekAhead } from '../../src/lib/weekAhead'
import { associationConfig } from '../../src/db/schema'
import { clearDb, seedBill, seedUser, seedSession } from '../helpers'

const sendBatch = vi.hoisted(() => vi.fn(async () => ({ sent: 1, failed: 0 })))
vi.mock('../../src/lib/email', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/lib/email')>(), senderFor: (e: unknown) => ({ sendBatch: (messages: unknown[]) => (sendBatch as (...a: unknown[]) => unknown)(e, messages) }) }))

// A pulled companion (#378) is analyzed because it shares a group with a tracked
// bill, and holds no match type or priority of its own. A group is one policy
// (#381), so its actions and hearings belong in the group's feed card and on the
// calendar under the group's priority. It stays out of the new-match surfaces,
// which key on match_type = 'keyword' (#550).

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 's', tags: [], relevanceScore: 7 }) }
})

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

function centralBillJson(handle: string, number: string, updatedAt: string) {
  return {
    billId: handle, sessionId: 'ri:2026', sessionName: '2026 Regular Session', yearStart: 2026, yearEnd: 2026,
    state: 'RI', number, title: 'Mail ballot processing', abstract: null, status: 'Introduced', statusDate: '2026-06-01',
    updatedAt, stateUrl: null, textHash: null, textR2Key: null, textStatus: 'no_texts', texts: [], actions: [],
    sponsors: [], votes: [], relatedBills: [],
  }
}

const testEnv = { ...env, TENANT_ID: 'ri', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x' }

function calendarBlock(day = 5) {
  const event = {
    identityKey: '1|house cmte on elections', date: isoDay(day), time: '14:00:00',
    location: 'Room 35', description: 'House Cmte on Elections', eventHash: 'h1',
  }
  return { events: [event], changes: [{ changeType: 'hearing_added' as const, ...event }] }
}

const actionChange = [{ changeType: 'action_added', oldValue: null, newValue: 'Referred to committee', detail: null, detectedAt: '2026-06-03T00:00:00Z' }]

describe('processCentralNotification: a pulled companion in a group', () => {
  const db = () => getDb(env.DB)
  let cookie: string
  let adminId: string
  // A pulled companion has a match type of none, no priority, and a group; its group mate is tracked.
  const COMPANION = 'legiscan:200'
  const MATE = 'legiscan:100'

  function serve(handle: string, number: string, updatedAt: string) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(centralBillJson(handle, number, updatedAt)), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))
  }
  async function deliver(handle: string, extra: Record<string, unknown>) {
    // Central's full delivery to an instance that didn't match the bill carries a null match type.
    await processCentralNotification({ tenantId: 'ri', billId: handle, forceMetadata: false, forceAI: false, matchType: null, ...extra } as never, testEnv as never, db())
  }
  async function feed(qs = '') {
    const res = await SELF.fetch(`http://localhost/api/feed${qs}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return (await res.json() as { events: Array<{ type: string; billId: string | null; billGroupKey: string | null; billPriority: string | null }> }).events
  }
  async function calendar() {
    const res = await SELF.fetch(`http://localhost/api/calendar/events?from=${isoDay(-30)}&to=${isoDay(60)}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as Array<{ source: string; bills: Array<{ id: string; priority: string | null }> }>
  }
  const setGroupPriority = (priority: 'high' | null) =>
    db().update(bills).set({ priority, prioritySetAt: priority ? '2026-06-01 09:00:00' : null }).where(eq(bills.id, 'a-mate'))

  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    adminId = await seedUser({ role: 'admin', email: 'ada@example.com' })
    cookie = `session=${await seedSession(adminId)}`
    // Ids sort a < b, so the group's key is the tracked mate's id.
    await seedBill({
      id: 'a-mate', billNumber: 'H 100', externalId: MATE, matchType: 'keyword', priority: 'high',
      aiProcessedAt: '2026-06-01T00:00:00Z',
    })
    await db().update(bills).set({ prioritySetAt: '2026-06-01 09:00:00' }).where(eq(bills.id, 'a-mate'))
    await seedBill({
      id: 'b-companion', billNumber: 'S 200', externalId: COMPANION, matchType: null,
      aiProcessedAt: '2026-06-01T00:00:00Z', providerUpdatedAt: '2026-06-01T00:00:00Z',
    })
    // Grouped by hand, so the group survives the processor's own reconciliation of companions against central's links.
    await groupByHand(db(), 'a-mate', 'b-companion', adminId)
    expect((await db().select({ k: bills.groupKey }).from(bills).where(eq(bills.id, 'b-companion')).get())?.k).toBe('a-mate')
  })

  it('writes a bill_updated feed event for its action, and the event shows in the group\'s feed card', async () => {
    serve(COMPANION, 'S 200', '2026-06-03T00:00:00Z')
    await deliver(COMPANION, { changes: actionChange })

    const stored = await db().select().from(feedEvents).where(eq(feedEvents.billId, 'b-companion')).all()
    expect(stored.map(e => e.type)).toEqual(['bill_updated'])

    // The group's priority is the mate's, so the passive event is visible in the default feed under the group's key.
    const shown = (await feed()).filter(e => e.billId === 'b-companion')
    expect(shown).toHaveLength(1)
    expect(shown[0].billGroupKey).toBe('a-mate')
    expect(shown[0].billPriority).toBe('high')
  })

  it('writes a calendar row for its hearing, shown on the calendar under the group\'s priority, with a hearing_added feed event', async () => {
    serve(COMPANION, 'S 200', '2026-06-03T00:00:00Z')
    await deliver(COMPANION, { calendar: calendarBlock() })

    const rows = await db().select().from(calendarEvents).where(eq(calendarEvents.billId, 'b-companion')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('confirmed')

    const hearings = (await calendar()).filter(e => e.source === 'hearing')
    expect(hearings).toHaveLength(1)
    expect(hearings[0].bills).toEqual([expect.objectContaining({ id: 'b-companion', priority: 'high' })])

    const types = (await db().select().from(feedEvents).where(eq(feedEvents.billId, 'b-companion')).all()).map(e => e.type)
    expect(types).toEqual(['hearing_added'])
  })

  it('shows its hearing in the ICS feed', async () => {
    serve(COMPANION, 'S 200', '2026-06-03T00:00:00Z')
    await deliver(COMPANION, { calendar: calendarBlock() })

    const info = await (await SELF.fetch('http://localhost/api/calendar/info', { headers: { Cookie: cookie } })).json() as { slug: string }
    const ics = await (await SELF.fetch(`http://localhost/api/calendar/feed/${info.slug}.ics`)).text()
    expect(ics).toContain('House Cmte on Elections')
    expect(ics).toContain('hearing-legiscan-200-')
  })

  it('lists its hearing in the week-ahead email, under the group\'s priority marker', async () => {
    const weekday = String(new Date().getUTCDay())
    await db().insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'week-ahead': { enabled: true, settings: { weeklyDay: weekday } } }) })
    sendBatch.mockClear()
    serve(COMPANION, 'S 200', '2026-06-03T00:00:00Z')
    await deliver(COMPANION, { calendar: calendarBlock(2) })

    await runWeekAhead(env as never, db())
    const html = (sendBatch.mock.calls.at(-1) as unknown as [unknown, { html: string }[]] | undefined)?.[1][0].html ?? ''
    expect(html).toContain('House Cmte on Elections')
    expect(html).toContain('RI S 200')
    expect(html).toContain(`title="${PRIORITY_COLORS.high.label}"`)
  })

  it('reconciles the hearing when the bill\'s own data is unchanged and the delivery short-circuits', async () => {
    serve(COMPANION, 'S 200', '2026-06-01T00:00:00Z')
    await deliver(COMPANION, { calendar: calendarBlock() })

    const rows = await db().select().from(calendarEvents).where(eq(calendarEvents.billId, 'b-companion')).all()
    expect(rows).toHaveLength(1)
  })

  it('writes each hearing once when the message is delivered twice', async () => {
    serve(COMPANION, 'S 200', '2026-06-03T00:00:00Z')
    await deliver(COMPANION, { calendar: calendarBlock(), changes: actionChange })
    await deliver(COMPANION, { calendar: calendarBlock(), changes: actionChange })

    expect(await db().select().from(calendarEvents).where(eq(calendarEvents.billId, 'b-companion')).all()).toHaveLength(1)
    const hearingEvents = (await db().select().from(feedEvents).where(eq(feedEvents.billId, 'b-companion')).all()).filter(e => e.type === 'hearing_added')
    expect(hearingEvents).toHaveLength(1)
  })

  it('still never reaches a new-match surface', async () => {
    serve(COMPANION, 'S 200', '2026-06-03T00:00:00Z')
    await deliver(COMPANION, { calendar: calendarBlock(), changes: actionChange })

    const row = await db().select().from(bills).where(eq(bills.id, 'b-companion')).get()
    expect(row?.matchType).toBeNull()
    expect(row?.newMatchAt).toBeNull()
    // No new-match event, no daily new-matches row.
    const types = (await db().select().from(feedEvents).all()).map(e => e.type)
    expect(types).not.toContain('bill_matched')
    expect(types).not.toContain('new_matches')
    // The new-match worklist leaves it out, and so does the feed: the group's priority puts its
    // updates on a card, but no new-match event or row reaches it.
    const worklist = await db().select({ id: bills.id }).from(bills).where(newMatchWhere(0)).all()
    expect(worklist.map(b => b.id)).not.toContain('b-companion')
    const onFeed = (await feed()).map(e => e.type)
    // The feed does show the group's update, so the absences below can fail on their own.
    expect(onFeed).toContain('bill_updated')
    expect(onFeed).not.toContain('bill_matched')
    expect(onFeed).not.toContain('new_matches')
  })

  it('keeps its events and rows when the group\'s priority is cleared, and shows none of them until a priority is set again', async () => {
    await setGroupPriority(null)
    serve(COMPANION, 'S 200', '2026-06-03T00:00:00Z')
    await deliver(COMPANION, { calendar: calendarBlock(), changes: actionChange })

    // Written: the data is the group's whatever its priority is today.
    expect(await db().select().from(calendarEvents).where(eq(calendarEvents.billId, 'b-companion')).all()).toHaveLength(1)
    expect((await db().select().from(feedEvents).where(eq(feedEvents.billId, 'b-companion')).all()).map(e => e.type).sort())
      .toEqual(['bill_updated', 'hearing_added'])
    // Read time hides it: a group with no priority shows nothing on the calendar, and its passive events stay out of the default feed.
    expect((await calendar()).filter(e => e.source === 'hearing')).toHaveLength(0)
    expect((await feed()).filter(e => e.billId === 'b-companion')).toHaveLength(0)

    await setGroupPriority('high')
    expect((await calendar()).filter(e => e.source === 'hearing')).toHaveLength(1)
    expect((await feed()).filter(e => e.billId === 'b-companion').length).toBeGreaterThan(0)
  })
})

describe('processCentralNotification: an ungrouped bill with no match type and no priority', () => {
  const db = () => getDb(env.DB)

  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    await seedBill({
      id: 'lone', billNumber: 'H 900', externalId: 'legiscan:900', matchType: null,
      aiProcessedAt: '2026-06-01T00:00:00Z', providerUpdatedAt: '2026-06-01T00:00:00Z',
    })
  })

  for (const [label, updatedAt] of [['a changed bill', '2026-06-03T00:00:00Z'], ['an unchanged bill', '2026-06-01T00:00:00Z']] as const) {
    it(`writes no feed event and no calendar row for ${label}`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(centralBillJson('legiscan:900', 'H 900', updatedAt)), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      ))
      await processCentralNotification({ tenantId: 'ri', billId: 'legiscan:900', calendar: calendarBlock(), changes: actionChange } as never, testEnv as never, db())
      expect(await db().select().from(calendarEvents).all()).toHaveLength(0)
      expect(await db().select().from(feedEvents).all()).toHaveLength(0)
    })
  }
})
