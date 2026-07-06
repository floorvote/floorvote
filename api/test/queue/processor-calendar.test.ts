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
    openstatesUrl: null,
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
  INSTANCE_PRESET: 'election_officials',
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
})
