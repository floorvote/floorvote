import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, sql } from 'drizzle-orm'
import { processCentralNotification } from '../../src/queue/processor'
import { getDb } from '../../src/db/client'
import { bills, feedEvents } from '../../src/db/schema'
import { groupByHand } from '../../src/lib/companionGroups'
import { clearDb, seedBill, seedUser } from '../helpers'

// The no-priority updates row (#919) is written by the processor as passive
// legislative events land on analyzed bills: one bill-less row a day. Which
// bills it lists is resolved when the feed loads (api/test/routes/
// feed.noPriorityRow.test.ts), so the write only has to make sure the day has
// its one row.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 's', tags: [], relevanceScore: 7 }) }
})

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

function centralBillJson(handle: string, number: string) {
  return {
    billId: handle, sessionId: 'ri:2026', sessionName: '2026 Regular Session', yearStart: 2026, yearEnd: 2026,
    state: 'RI', number, title: 'Ballot processing', abstract: null, status: 'Introduced', statusDate: '2026-06-01',
    updatedAt: '2026-06-02T00:00:00Z', stateUrl: null, textHash: null, textR2Key: null, textStatus: 'no_texts', texts: [], actions: [],
    sponsors: [], votes: [], relatedBills: [],
  }
}

const testEnv = { ...env, TENANT_ID: 'ri', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x' }

const actionChange = [{ changeType: 'action_added', oldValue: null, newValue: 'Referred to committee', detail: null, detectedAt: '2026-06-03T00:00:00Z' }]

function hearingBlock() {
  const event = {
    identityKey: '1|house cmte on elections', date: isoDay(5), time: '14:00:00',
    location: 'Room 35', description: 'House Cmte on Elections', eventHash: 'h1',
  }
  return { events: [event], changes: [{ changeType: 'hearing_added' as const, ...event }] }
}

describe('processCentralNotification: the no-priority updates row', () => {
  const db = () => getDb(env.DB)
  const BILLS: Record<string, string> = { 'legiscan:1': 'H 1', 'legiscan:2': 'H 2', 'legiscan:3': 'H 3' }

  async function deliver(handle: string, extra: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(centralBillJson(handle, BILLS[handle])), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    ))
    const matchType = (await db().select({ m: bills.matchType }).from(bills).where(eq(bills.externalId, handle)).get())?.m ?? null
    await processCentralNotification({ tenantId: 'ri', billId: handle, forceMetadata: false, forceAI: false, matchType, ...extra } as never, testEnv as never, db())
  }
  const rows = () => db().select().from(feedEvents).where(eq(feedEvents.type, 'no_priority_updates' as never)).all()
  const typesOf = async (billNumber: string) => {
    const bill = await db().select({ id: bills.id }).from(bills).where(eq(bills.billNumber, billNumber)).get()
    return (await db().select({ type: feedEvents.type }).from(feedEvents).where(eq(feedEvents.billId, bill!.id)).all()).map((e) => e.type)
  }

  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    // Existing, analyzed bills, so a delivery's changes become feed events.
    const analyzed = { matchType: 'keyword' as const, aiProcessedAt: '2026-06-01T00:00:00Z', providerUpdatedAt: '2026-06-01T00:00:00Z', relevanceScore: 6 }
    await seedBill({ id: 'a-1', externalId: 'legiscan:1', billNumber: 'H 1', ...analyzed })
    await seedBill({ id: 'b-2', externalId: 'legiscan:2', billNumber: 'H 2', ...analyzed })
    // A pulled companion: analyzed through its group, with no match type of its own.
    // Grouped by hand, so the group survives the processor's reconciliation of companions.
    await seedBill({ id: 'c-3', externalId: 'legiscan:3', billNumber: 'H 3', ...analyzed, matchType: null })
    await groupByHand(db(), 'a-1', 'c-3', await seedUser({ role: 'admin' }))
  })

  it('writes one bill-less system row for the day when an update lands on an analyzed bill', async () => {
    await deliver('legiscan:1', { changes: actionChange })

    expect(await typesOf('H 1')).toContain('bill_updated')
    const written = await rows()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ billId: null, userId: 'system', suppressed: false })
    expect(JSON.parse(written[0].metadata)).toEqual({})
  })

  it('keeps the one row for the day as more updates land, without moving it', async () => {
    await deliver('legiscan:1', { changes: actionChange })
    // The first update was earlier in the day.
    await db().update(feedEvents).set({ createdAt: sql`datetime('now', 'start of day')` }).where(eq(feedEvents.type, 'no_priority_updates' as never))
    const [first] = await rows()

    await deliver('legiscan:2', { changes: actionChange })
    await deliver('legiscan:1', { changes: [{ ...actionChange[0], newValue: 'Hearing held' }] })

    expect(await rows()).toEqual([first])
  })

  it('writes a new row on a new day', async () => {
    await deliver('legiscan:1', { changes: actionChange })
    await db().update(feedEvents).set({ createdAt: sql`datetime('now', '-1 day')` }).where(eq(feedEvents.type, 'no_priority_updates' as never))

    await deliver('legiscan:2', { changes: actionChange })

    expect(await rows()).toHaveLength(2)
  })

  it('writes the row for an update on an analyzed bill with a priority too, which the feed then resolves without it', async () => {
    await db().update(bills).set({ priority: 'high' }).where(eq(bills.externalId, 'legiscan:1'))
    await deliver('legiscan:1', { changes: actionChange })
    expect(await rows()).toHaveLength(1)
  })

  it('writes no row for an update on a bill with no match type', async () => {
    await deliver('legiscan:3', { changes: actionChange })
    expect(await typesOf('H 3')).toContain('bill_updated')
    expect(await rows()).toHaveLength(0)
  })

  it('writes no row for a delivery with no changes', async () => {
    await deliver('legiscan:1', {})
    expect(await rows()).toHaveLength(0)
  })

  it('writes the row when a hearing lands on an analyzed bill', async () => {
    await deliver('legiscan:2', { calendar: hearingBlock() })
    expect(await typesOf('H 2')).toEqual(['hearing_added'])
    expect(await rows()).toHaveLength(1)
  })

  it('writes no row for a hearing on a bill with no match type', async () => {
    await deliver('legiscan:3', { calendar: hearingBlock() })
    expect(await typesOf('H 3')).toEqual(['hearing_added'])
    expect(await rows()).toHaveLength(0)
  })
})
