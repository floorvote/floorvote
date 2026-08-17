import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { eq } from 'drizzle-orm'
import { bills } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({
      summary: 'Generated summary',
      tags: ['Elections'],
      relevanceScore: 7,
    }),
  }
})

const BILL_ID = 'legiscan:42'

const fakeCentralBill = {
  billId: BILL_ID,
  sessionId: 'ri:2026',
  sessionName: '2026 Regular Session',
  state: 'RI',
  number: 'S2655',
  title: 'Energy Facility Act',
  abstract: 'Concerns energy facility siting',
  status: 'introduced',
  statusDate: '2026-05-01',
  updatedAt: '2026-05-21T00:00:00Z',
  openstatesUrl: null,
  stateUrl: 'https://state.ri.us/S2655',
  textHash: 'h-stub',
  textR2Key: null,
  texts: [
    {
      docId: 'd1',
      note: 'Introduced',
      date: '2026-05-01',
      links: [{ url: 'https://x/1', mediaType: 'text/html' }],
    },
  ],
  actions: [
    { description: 'Committee recommended', date: '2026-05-20', chamber: 'upper', classification: [], order: 1 },
  ],
  sponsors: [
    { name: 'Smith', party: 'D', role: 'Senator', primary: true, personId: 'p1', url: null },
  ],
  votes: [],
  relatedBills: [],
}

const testEnv = {
  ...env,
  TENANT_ID: 'test-tenant',
  CENTRAL_API_URL: 'https://central.test',
}

describe('processCentralNotification with stubOnly=true', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
  })

  it('upserts metadata, skips text fetch and AI', async () => {
    const textFetchSpy = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        textFetchSpy()
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: 'full text' }) })
      }
      return Promise.resolve({ ok: true, json: async () => fakeCentralBill })
    }))

    const db = getDb(env.DB)
    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, stubOnly: true }
    await processCentralNotification(msg, testEnv as any, db)

    const bill = await db.select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
    expect(bill).toBeDefined()
    expect(bill?.title).toBe('Energy Facility Act')
    expect(bill?.lastAction).toBe('Committee recommended')
    expect(bill?.aiProcessedAt).toBe(null)
    expect(bill?.tenantSummary).toBe(null)
    expect(bill?.matchType).toBe(null)  // stubOnly preserves null matchType
    expect(textFetchSpy).not.toHaveBeenCalled()

    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
  })

  it('non-stub forceMetadata message overwrites prior stub metadata with full data', async () => {
    const db = getDb(env.DB)

    // Seed a bill that was previously stub-loaded (only had basic metadata, no AI)
    await db.insert(bills).values({
      id: 'b1',
      externalId: BILL_ID,
      billNumber: 'S2655',
      title: 'Old title',
      state: 'RI',
      status: 'introduced',
      session: '',
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>text</p>' }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({
        ...fakeCentralBill,
        title: 'Promoted title',
        textHash: 'h-full',
      }) })
    }))

    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, forceMetadata: true }
    await processCentralNotification(msg, testEnv as any, db)

    const bill = await db.select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
    expect(bill?.title).toBe('Promoted title')
    // Title was refreshed and AI ran (because keyword 'energy' from default treat-as-match would apply,
    // and the AI gate runs when matchType !== null or for new bills with no matchType).
    // We don't strongly assert AI ran here — the dedicated test for that is in processor.test.ts.
  })

  it('skips stub upsert when bill already has aiProcessedAt (post-promote guard)', async () => {
    const db = getDb(env.DB)

    // Seed a fully-processed (non-stub) bill with aiProcessedAt set, simulating
    // a bill that was promoted to full tracking before this stub message arrived.
    const aiTimestamp = '2026-05-20T12:00:00Z'
    await db.insert(bills).values({
      id: 'b-promoted',
      externalId: BILL_ID,
      billNumber: 'S2655',
      title: 'Promoted full title',
      state: 'RI',
      status: 'introduced',
      session: '2026',
      aiProcessedAt: aiTimestamp,
      tenantSummary: 'Existing AI summary',
    })

    const textFetchSpy = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        textFetchSpy()
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: 'full text' }) })
      }
      return Promise.resolve({ ok: true, json: async () => fakeCentralBill })
    }))

    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, stubOnly: true }
    await processCentralNotification(msg, testEnv as any, db)

    const bill = await db.select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
    // Stub guard should have short-circuited — fields remain unchanged
    expect(bill?.title).toBe('Promoted full title')
    expect(bill?.aiProcessedAt).toBe(aiTimestamp)
    expect(bill?.tenantSummary).toBe('Existing AI summary')
    expect(textFetchSpy).not.toHaveBeenCalled()
  })

  it('metadataOnly refreshes metadata, skips text fetch and AI', async () => {
    const db = getDb(env.DB)

    await db.insert(bills).values({
      id: 'b-md',
      externalId: BILL_ID,
      billNumber: 'S2655',
      title: 'Stale title',
      state: 'RI',
      status: 'introduced',
      session: '2026',
      history: JSON.stringify([{ date: '2026-01-01', action: 'old', chamber: null }, { date: '2026-01-01', action: 'old', chamber: null }]),
    })

    const textFetchSpy = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        textFetchSpy()
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: 'full text' }) })
      }
      return Promise.resolve({ ok: true, json: async () => fakeCentralBill })
    }))

    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, metadataOnly: true }
    await processCentralNotification(msg, testEnv as any, db)

    const bill = await db.select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
    expect(bill).toBeDefined()
    // metadata refreshed from central
    expect(bill?.title).toBe('Energy Facility Act')
    expect(bill?.lastAction).toBe('Committee recommended')
    // history rewritten to clean central data (one action, not stale duplicate rows)
    const parsedHistory = JSON.parse(bill?.history ?? '[]')
    expect(parsedHistory).toHaveLength(1)
    expect(parsedHistory[0].action).toBe('Committee recommended')
    // AI fields untouched
    expect(bill?.aiProcessedAt).toBe(null)
    expect(bill?.tenantSummary).toBe(null)
    // No text fetch, no AI
    expect(textFetchSpy).not.toHaveBeenCalled()
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
  })

  it('skips AI when central has no full text, leaving bill as stub', async () => {
    const textFetchSpy = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        textFetchSpy()
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: 'full text' }) })
      }
      // Central returns the bill with no texts and no textHash — text fetch
      // upstream failed (or text just isn't available yet).
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ...fakeCentralBill,
          textHash: null,
          texts: [],
        }),
      })
    }))

    const db = getDb(env.DB)
    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, forceAI: true }
    await processCentralNotification(msg, testEnv as any, db)

    const bill = await db.select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
    expect(bill).toBeDefined()
    // No AI ran
    expect(bill?.aiProcessedAt).toBe(null)
    expect(bill?.tenantSummary).toBe(null)
    // Metadata still upserted
    expect(bill?.title).toBe('Energy Facility Act')
    // No text fetch attempted, no AI call
    expect(textFetchSpy).not.toHaveBeenCalled()
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
  })

  it('skips stub upsert when bill matchType is manual', async () => {
    const db = getDb(env.DB)

    // Seed a manually-added bill (matchType='manual', non-stub).
    await db.insert(bills).values({
      id: 'b-manual',
      externalId: BILL_ID,
      billNumber: 'S2655',
      title: 'Manually added bill',
      state: 'RI',
      matchType: 'manual',
      status: 'introduced',
      session: '2026',
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: 'full text' }) })
      }
      return Promise.resolve({ ok: true, json: async () => fakeCentralBill })
    }))

    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, stubOnly: true }
    await processCentralNotification(msg, testEnv as any, db)

    const bill = await db.select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
    // Manual bills' title is preserved (stubOnly guard rejects the message)
    expect(bill?.title).toBe('Manually added bill')
    expect(bill?.matchType).toBe('manual')
  })
})
