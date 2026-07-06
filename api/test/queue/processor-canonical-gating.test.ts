// Regression tests for F5+B5: tenant-side gating must use canonical fields
// (`match_type`, `ai_processed_at`) rather than the older ad-hoc booleans
// (`is_stub`, `keywordMatch`).
//
// §B5 — Manual bills must re-run AI on text changes even when keywords don't
// match. Under the old gate `shouldRunAi = forceAI || keywordMatch`, a manual
// bill whose title+abstract doesn't satisfy the tenant's keywords would only
// get AI once (via the initial promote-bill's forceAI). Subsequent text
// changes would never trigger AI re-run, freezing the summary.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills, associationConfig } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({
      summary: 'AI-generated summary',
      tags: ['Other'],
      relevanceScore: 5,
    }),
  }
})

const BILL_ID = 'ocd-bill/test-canonical-gating'

// A bill whose title/abstract do NOT match the keyword set we'll configure
// below. The point is to demonstrate that matchType (not keyword recheck)
// should drive AI eligibility.
const nonKeywordCentralBill = {
  billId: BILL_ID,
  sessionId: 'ri:2026',
  state: 'RI',
  number: 'HB 999',
  title: 'Workers Compensation Reform Act',
  abstract: 'Amends provisions relating to workers compensation hearings.',
  status: 'introduced',
  statusDate: '2026-01-01',
  updatedAt: '2026-01-10T12:00:00Z',
  openstatesUrl: 'https://openstates.org/ri/bills/2026/HB999/',
  stateUrl: 'https://legisinfo.ri.gov/bills/HB999',
  textHash: 'text-hash-v1',
  textR2Key: 'bills/test-canonical-gating/ver-001.html',
  providerData: null,
  texts: [
    {
      docId: 'ver-uuid-canonical-001',
      note: 'Introduced',
      date: '2026-01-01',
      links: [{ url: 'https://legisinfo.ri.gov/HB999.html', mediaType: 'text/html' }],
    },
  ],
  documents: [],
  actions: [
    { description: 'Introduced', date: '2026-01-01', chamber: 'lower', classification: ['introduction'], order: 1 },
  ],
  sponsors: [
    { name: 'Rep Test', party: 'D', role: 'Representative', primary: true, personId: 'ocd-person/test-1' },
  ],
  votes: [],
  relatedBills: [],
}

const testEnv = {
  ...env,
  TENANT_ID: 'test-org',
  CENTRAL_API_URL: 'https://central.test',
  INSTANCE_PRESET: 'election_officials',
}

describe('F5+B5: canonical-field gating', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
  })

  it('§B5 — manual bill with non-matching keywords still runs AI on text change', async () => {
    // Setup: tenant configured with election keywords; bill is about workers comp
    // (doesn't match). The bill was previously manually promoted by an admin,
    // so it has matchType='manual' and was AI-processed once already.
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election', 'voting', 'ballot']) })

    // First ingest: simulate the initial promote (matchType='manual', forceAI=true)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>Original text</p>' }) })
      }
      return Promise.resolve({ ok: true, json: async () => nonKeywordCentralBill })
    }))
    const promoteMsg: TenantQueueMessage = {
      tenantId: 'test-org',
      billId: BILL_ID,
      matchType: 'manual',
      forceAI: true,
    }
    await processCentralNotification(promoteMsg, testEnv as any, db)

    // Sanity: bill stored as manual, AI ran on the first promote
    const afterPromote = await db.select().from(bills).get()
    expect(afterPromote?.matchType).toBe('manual')
    expect(afterPromote?.aiProcessedAt).not.toBeNull()
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()

    // Now simulate: LegiScan publishes amended text. Central updates its
    // bill row; cron queues a normal forceMetadata=true message.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>Amended text — different content</p>' }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({
        ...nonKeywordCentralBill,
        textHash: 'text-hash-v2-AMENDED',   // text content changed
        updatedAt: '2026-02-01T12:00:00Z',
      }) })
    }))

    const updateMsg: TenantQueueMessage = {
      tenantId: 'test-org',
      billId: BILL_ID,
      forceMetadata: true,  // bypass providerUpdatedAt dedup
    }
    await processCentralNotification(updateMsg, testEnv as any, db)

    // §B5 invariant: AI should re-run because matchType='manual' marks this
    // bill as user-tracked, regardless of keyword match. Under the old
    // (buggy) gate `forceAI || keywordMatch`, keywordMatch is false for this
    // workers-comp bill and AI would not re-run.
    expect(processBill).toHaveBeenCalledTimes(1)

    const afterUpdate = await db.select().from(bills).get()
    expect(afterUpdate?.lastAiTextHash).toBe('text-hash-v2-AMENDED')
  })

  it('§C1 — dedup short-circuit uses ai_processed_at, not is_stub', async () => {
    // A bill that's fully processed (AI ran) should be skipped on a re-ingest
    // with same providerUpdatedAt. This test makes sure the dedup key is
    // `aiProcessedAt !== null` (canonical) rather than `isStub === false`
    // (vestigial).
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['workers']) })

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>Text</p>' }) })
      }
      return Promise.resolve({ ok: true, json: async () => nonKeywordCentralBill })
    }))

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()

    // Same provider updatedAt → should dedup (skip reprocess entirely)
    await processCentralNotification(msg, testEnv as any, db)
    expect(processBill).not.toHaveBeenCalled()
  })

  it('§C1 — monitoring-only bill (match_type=null) does not fire feed events on changes', async () => {
    // Under the new gate `existing.matchType !== null`, a monitoring-only
    // bill with no match_type should not generate feed events even if it has
    // changes. Equivalent to the old gate `!existing.isStub` for the
    // monitoring-only case (since isStub=true there).
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['zoning']) })

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) return Promise.resolve({ ok: true, status: 404, json: async () => ({}) })
      return Promise.resolve({ ok: true, json: async () => nonKeywordCentralBill })
    }))

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)

    // Re-ingest with a status change
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) return Promise.resolve({ ok: true, status: 404, json: async () => ({}) })
      return Promise.resolve({ ok: true, json: async () => ({
        ...nonKeywordCentralBill, status: 'in_committee', updatedAt: '2026-02-01T00:00:00Z',
      }) })
    }))
    const force: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, forceMetadata: true, changes: [{ changeType: 'status_change', oldValue: 'introduced', newValue: 'in_committee', detail: null, detectedAt: '2026-02-01T00:00:00Z' }] }
    await processCentralNotification(force, testEnv as any, db)

    const { feedEvents } = await import('../../src/db/schema')
    const events = await db.select().from(feedEvents).all()
    expect(events.filter(e => e.type === 'bill_updated')).toHaveLength(0)
  })
})
