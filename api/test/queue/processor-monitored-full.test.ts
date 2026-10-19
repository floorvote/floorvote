import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills, billTexts, calendarEvents, feedEvents } from '../../src/db/schema'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({ summary: 'Generated', tags: ['Elections'], relevanceScore: 7 }),
  }
})

const BILL_ID = 'lims:B26-0001'

const centralBill = {
  billId: BILL_ID,
  sessionId: 'dc:26',
  sessionName: 'Council Period 26',
  state: 'DC',
  number: 'B26-0001',
  title: 'Street Naming Act',
  abstract: 'Names a street',
  status: 'introduced',
  statusDate: '2026-05-01',
  updatedAt: '2026-05-21T00:00:00Z',
  stateUrl: 'https://lims.dccouncil.gov/B26-0001',
  textHash: 'h-full',
  textR2Key: null,
  textStatus: 'available',
  texts: [{ docId: 'd1', note: 'Introduced', date: '2026-05-01', links: [{ url: 'https://x/1', mediaType: 'application/pdf' }] }],
  actions: [{ description: 'Introduced', date: '2026-05-02', chamber: 'upper', classification: [], order: 1 }],
  sponsors: [{ name: 'Smith', party: 'D', role: 'Councilmember', primary: true, personId: 'p1', url: null }],
  votes: [],
  relatedBills: [],
}

const testEnv = { ...env, TENANT_ID: 'dc', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x' }

const calendar = {
  events: [{ identityKey: 'k1', date: '2026-06-04', time: '14:00:00', location: 'Room 35', description: 'Hearing', eventHash: 'h1' }],
  changes: [{ changeType: 'hearing_added' as const, identityKey: 'k1', date: '2026-06-04', time: '14:00:00', location: 'Room 35', description: 'Hearing', eventHash: 'h1' }],
}

const get = () => getDb(env.DB).select().from(bills).where(eq(bills.externalId, BILL_ID)).get()

describe('a monitored bill (matchType null) with a full ingest', () => {
  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      Promise.resolve(url.includes('/text')
        ? new Response(JSON.stringify({ type: 'html', content: '<p>text</p>' }), { status: 200 })
        : new Response(JSON.stringify(centralBill), { status: 200 })),
    ))
  })

  it('stores history, sponsors, and texts, marks it fully ingested, and runs no AI, feed event, or hearing mirror', async () => {
    const db = getDb(env.DB)
    await processCentralNotification(
      { tenantId: 'dc', billId: BILL_ID, matchType: null, calendar } as any, testEnv as any, db,
    )
    const bill = await get()
    expect(bill?.sponsor).toBe('Smith')
    expect(JSON.parse(bill!.history!)).toHaveLength(1)
    expect(await db.select().from(billTexts).where(eq(billTexts.billId, bill!.id)).all()).toHaveLength(1)
    expect(bill?.fullyIngestedAt).toBeTruthy()
    expect(bill?.matchType).toBeNull()
    expect(bill?.aiProcessedAt).toBeNull()
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
    expect(await db.select().from(feedEvents).all()).toHaveLength(0)
    expect(await db.select().from(calendarEvents).all()).toHaveLength(0)
  })

  it('does not mark a bill fully ingested for a stubOnly message', async () => {
    await processCentralNotification({ tenantId: 'dc', billId: BILL_ID, stubOnly: true } as any, testEnv as any, getDb(env.DB))
    const bill = await get()
    expect(bill).toBeDefined()
    expect(bill?.fullyIngestedAt).toBeNull()
  })

  it('keeps a bill fully ingested when a later stubOnly message refreshes it', async () => {
    const db = getDb(env.DB)
    await processCentralNotification({ tenantId: 'dc', billId: BILL_ID, matchType: null } as any, testEnv as any, db)
    await processCentralNotification({ tenantId: 'dc', billId: BILL_ID, stubOnly: true } as any, testEnv as any, db)
    expect((await get())?.fullyIngestedAt).toBeTruthy()
  })
})
