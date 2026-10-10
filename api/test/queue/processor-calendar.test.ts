import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { processCentralNotification } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { calendarEvents, feedEvents } from '../../src/db/schema'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill } from '../helpers'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({
      summary: 'Test summary',
      tags: ['Elections'],
      relevanceScore: 7,
    }),
  }
})

// Minimal CentralBill the processor expects from GET /bills/:id.
function centralBillJson(number = 'H 5174') {
  return {
    billId: 'legiscan:999',
    sessionId: 'ri:2026',
    sessionName: '2026 Regular Session',
    yearStart: 2026,
    yearEnd: 2026,
    state: 'RI',
    number,
    title: 'Mail ballot processing',
    abstract: null,
    status: 'Introduced',
    statusDate: '2026-06-01',
    updatedAt: '2026-06-02T00:00:00Z',
    stateUrl: null,
    textHash: null,
    textR2Key: null,
    textStatus: 'no_texts',
    texts: [],
    actions: [],
    sponsors: [],
    votes: [],
    relatedBills: [],
  }
}

const testEnv = {
  ...env,
  TENANT_ID: 'ri',
  CENTRAL_API_URL: 'https://central.test',
  CENTRAL_ADMIN_SECRET: 'x',
}

function calendarBlock(changeType: 'hearing_added' | 'hearing_changed' | 'hearing_cancelled' = 'hearing_added') {
  const event = {
    identityKey: '1|house cmte on elections', date: '2026-06-04', time: '14:00:00',
    location: 'Room 35', description: 'House Cmte on Elections', eventHash: 'h1',
  }
  return {
    events: changeType === 'hearing_cancelled' ? [] : [event],
    changes: [{ changeType, ...event }],
  }
}

describe('processCentralNotification — calendar mirror', () => {
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(centralBillJson()), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))
    // Existing, tracked, AI-processed bill so it is NOT "new".
    billId = await seedBill({
      billNumber: 'H 5174',
      state: 'RI',
      session: '2026 Regular Session',
      externalId: 'legiscan:999',
      matchType: 'keyword',
      priority: 'high',
      aiProcessedAt: '2026-06-01T00:00:00Z',
    })
  })

  it('inserts a calendar_events row from a hearing_added block', async () => {
    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_added') } as any,
      testEnv as any, getDb(env.DB),
    )
    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('confirmed')
    expect(rows[0].date).toBe('2026-06-04')
    expect(rows[0].uid).toContain('@ri')
  })

  it('keeps hearing UIDs byte-for-byte stable, so calendar subscribers see no churn', async () => {
    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_added') } as any,
      testEnv as any, getDb(env.DB),
    )
    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
    expect(rows.map(r => r.uid)).toEqual(['hearing-legiscan-999-1-house-cmte-on-elections@ri'])
  })

  it('keeps the body event central says covers an entry, and leaves it when a central sends no cover', async () => {
    const send = (coveredBy?: string | null) => {
      const block = calendarBlock('hearing_added')
      if (coveredBy !== undefined) Object.assign(block.events[0], { coveredBy })
      return processCentralNotification({ tenantId: 'ri', billId: 'legiscan:999', calendar: block } as any, testEnv as any, getDb(env.DB))
    }
    const cover = async () => (await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).get())?.coveredBy
    await send('council-2405@lims.dccouncil.gov')
    expect(await cover()).toBe('council-2405@lims.dccouncil.gov')
    await send()
    expect(await cover()).toBe('council-2405@lims.dccouncil.gov')
    await send(null)
    expect(await cover()).toBeNull()
    // The cover never touches the SEQUENCE: the entry didn't change.
    expect((await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).get())?.sequence).toBe(0)
  })

  it('writes a hearing_added feed event for a tracked, non-new bill', async () => {
    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_added') } as any,
      testEnv as any, getDb(env.DB),
    )
    const fe = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.billId, billId)).all()
    expect(fe.some(e => e.type === 'hearing_added')).toBe(true)
  })

  it('bumps sequence on hearing_changed (same identity, new hash)', async () => {
    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_added') } as any,
      testEnv as any, getDb(env.DB),
    )
    const changed = calendarBlock('hearing_changed')
    changed.events[0].eventHash = 'h2'
    changed.changes[0].eventHash = 'h2'
    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: changed } as any,
      testEnv as any, getDb(env.DB),
    )
    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].sequence).toBe(1)
    expect(rows[0].eventHash).toBe('h2')
  })

  it('marks a hearing cancelled when it disappears from the events set', async () => {
    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_added') } as any,
      testEnv as any, getDb(env.DB),
    )
    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_cancelled') } as any,
      testEnv as any, getDb(env.DB),
    )
    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('cancelled')
    const fe = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.billId, billId)).all()
    expect(fe.some(e => e.type === 'hearing_cancelled')).toBe(true)
  })

  it('still reconciles calendar when the bill metadata dedup early-returns', async () => {
    // Reset the bill so its providerUpdatedAt matches the central mock's updatedAt ('2026-06-02T00:00:00Z')
    // AND aiProcessedAt is set — this triggers the early-return dedup branch in processCentralNotification.
    await resetDb()
    await applyMigrations()
    billId = await seedBill({
      billNumber: 'H 5174',
      state: 'RI',
      session: '2026 Regular Session',
      externalId: 'legiscan:999',
      matchType: 'keyword',
      priority: 'high',
      aiProcessedAt: '2026-06-01T00:00:00Z',
      providerUpdatedAt: '2026-06-02T00:00:00Z', // matches centralBillJson().updatedAt exactly
    })

    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_added') } as any,
      testEnv as any, getDb(env.DB),
    )

    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('confirmed')

    const fe = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.billId, billId)).all()
    expect(fe.some(e => e.type === 'hearing_added')).toBe(true)
  })

  it('reconciles calendar for a stub bill (matchType null) when it has priority set', async () => {
    await resetDb()
    await applyMigrations()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({
        ...centralBillJson('H 7777'),
        billId: 'legiscan:777',
        matchType: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))
    const stubBillId = await seedBill({
      billNumber: 'H 7777',
      state: 'RI',
      session: '2026 Regular Session',
      externalId: 'legiscan:777',
      priority: 'high',
      // matchType intentionally omitted (defaults null) — this is a prioritized stub
    })

    await processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:777', calendar: calendarBlock('hearing_added') } as any,
      testEnv as any, getDb(env.DB),
    )

    const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, stubBillId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('confirmed')
    expect(rows[0].date).toBe('2026-06-04')
  })

  it('re-delivering the same hearing message produces exactly one calendar_events row and one feed_events row', async () => {
    const msg = { tenantId: 'ri', billId: 'legiscan:999', calendar: calendarBlock('hearing_added') } as any
    const db = getDb(env.DB)

    // Deliver the same message twice (simulating Cloudflare Queues at-least-once re-delivery).
    await processCentralNotification(msg, testEnv as any, db)
    await processCentralNotification(msg, testEnv as any, db)

    const rows = await db.select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
    expect(rows).toHaveLength(1)

    const fe = await db.select().from(feedEvents).where(eq(feedEvents.billId, billId)).all()
    const hearingAddedEvents = fe.filter(e => e.type === 'hearing_added')
    expect(hearingAddedEvents).toHaveLength(1)
  })

  // The ICS SEQUENCE a calendar client last saw must never come round again,
  // or the client keeps its stale copy (#295).
  describe('ICS sequence', () => {
    const deliver = (calendar: object) => processCentralNotification(
      { tenantId: 'ri', billId: 'legiscan:999', calendar } as any, testEnv as any, getDb(env.DB),
    )
    const row = async () => (await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all())[0]

    it('rises with each change, cancellation, and return, and never falls back', async () => {
      const seen: number[] = []
      await deliver(calendarBlock('hearing_added'))
      seen.push((await row()).sequence)
      await deliver(calendarBlock('hearing_cancelled'))
      seen.push((await row()).sequence)
      // The same hearing comes back unchanged: a client that saw it cancelled needs a higher SEQUENCE to see it confirmed.
      await deliver(calendarBlock('hearing_added'))
      seen.push((await row()).sequence)
      const changed = calendarBlock('hearing_changed')
      changed.events[0].eventHash = 'h2'
      changed.changes[0].eventHash = 'h2'
      await deliver(changed)
      seen.push((await row()).sequence)
      expect(seen).toEqual([0, 1, 2, 3])
      expect((await row()).status).toBe('confirmed')
    })

    it('stays put when the same message is delivered again', async () => {
      await deliver(calendarBlock('hearing_added'))
      await deliver(calendarBlock('hearing_cancelled'))
      await deliver(calendarBlock('hearing_added'))
      await deliver(calendarBlock('hearing_added'))
      expect((await row()).sequence).toBe(2)
    })
  })

  describe('kinds', () => {
    it('stores the kind central sent, and keeps it when an older central sends none', async () => {
      const block = calendarBlock('hearing_added')
      await processCentralNotification(
        { tenantId: 'ri', billId: 'legiscan:999', calendar: { events: [{ ...block.events[0], kind: 'markup' }], changes: [] } } as any,
        testEnv as any, getDb(env.DB),
      )
      await processCentralNotification(
        { tenantId: 'ri', billId: 'legiscan:999', calendar: { events: block.events, changes: [] } } as any,
        testEnv as any, getDb(env.DB),
      )
      const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
      expect(rows.map(r => [r.kind, r.uid])).toEqual([['markup', 'hearing-legiscan-999-1-house-cmte-on-elections@ri']])
    })

    it('puts a deadline on the calendar, and keeps it out of the feed\'s hearing news', async () => {
      const deadline = {
        identityKey: 'deadline|2026-06-20|mayor\'s response due', kind: 'deadline', date: '2026-06-20', time: null,
        location: null, description: 'Mayor\'s response due', eventHash: 'd1',
      }
      await processCentralNotification(
        { tenantId: 'ri', billId: 'legiscan:999', calendar: { events: [deadline], changes: [{ changeType: 'hearing_added', ...deadline }] } } as any,
        testEnv as any, getDb(env.DB),
      )
      const rows = await getDb(env.DB).select().from(calendarEvents).where(eq(calendarEvents.billId, billId)).all()
      expect(rows.map(r => [r.kind, r.description, r.status, r.uid])).toEqual([
        ['deadline', 'Mayor\'s response due', 'confirmed', 'hearing-legiscan-999-deadline-2026-06-20-mayor-s-response-due@ri'],
      ])
      const fe = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.billId, billId)).all()
      expect(fe.filter(e => e.type.startsWith('hearing_'))).toEqual([])
    })
  })
})
