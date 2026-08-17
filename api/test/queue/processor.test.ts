import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { eq } from 'drizzle-orm'
import { bills, associationConfig, billTexts, feedEvents } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({
      summary: 'Directly affects absentee ballot handling',
      tags: ['Elections'],
      relevanceScore: 8,
    }),
  }
})

const BILL_ID = 'ocd-bill/test-uuid-00000000-0001'

const fakeCentralBill = {
  billId: BILL_ID,
  sessionId: 'ri:2026',
  state: 'RI',
  number: 'HB 100',
  title: 'Election Administration Act',
  abstract: 'An act relating to election administration',
  status: 'introduced',
  statusDate: '2026-01-01',
  updatedAt: '2026-01-10T12:00:00Z',
  openstatesUrl: 'https://openstates.org/ri/bills/2026/HB100/',
  stateUrl: 'https://legisinfo.ri.gov/bills/HB100',
  textHash: 'hash-abc123',
  textR2Key: 'bills/test-uuid-00000000-0001/ver-001.html',
  providerData: null,
  texts: [
    {
      docId: 'ver-uuid-001',
      note: 'Introduced',
      date: '2026-01-01',
      links: [{ url: 'https://legisinfo.ri.gov/HB100.html', mediaType: 'text/html' }],
    },
  ],
  documents: [],
  actions: [
    { description: 'Introduced in House', date: '2026-01-10', chamber: 'lower', classification: ['introduction'], order: 1 },
  ],
  sponsors: [
    { name: 'Jane Smith', party: 'D', role: 'Representative', primary: true, personId: 'ocd-person/123' },
    { name: 'Bob Jones', party: 'R', role: 'Representative', primary: false, personId: 'ocd-person/456' },
  ],
  votes: [],
  relatedBills: [],
}

const testEnv = {
  ...env,
  TENANT_ID: 'test-org',
  CENTRAL_API_URL: 'https://central.test',
}

describe('processCentralNotification', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>Bill text</p>' }) })
      }
      return Promise.resolve({ ok: true, json: async () => fakeCentralBill })
    }))
  })

  it('ignores messages for other tenants', async () => {
    const db = getDb(env.DB)
    const msg: TenantQueueMessage = { tenantId: 'other-tenant', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    expect(await db.select().from(bills).all()).toHaveLength(0)
  })

  it('upserts bill metadata from normalized central response', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const row = await db.select().from(bills).get()
    expect(row).not.toBeNull()
    expect(row!.billNumber).toBe('HB 100')
    expect(row!.externalId).toBe(BILL_ID)
    expect(row!.state).toBe('RI')
    expect(row!.abstract).toBe('An act relating to election administration')
    expect(row!.url).toBe('https://openstates.org/ri/bills/2026/HB100/')
    expect(row!.stateUrl).toBe('https://legisinfo.ri.gov/bills/HB100')
    expect(row!.status).toBe('introduced')
    expect(row!.providerUpdatedAt).toBe('2026-01-10T12:00:00Z')
    expect(row!.sponsor).toBe('Jane Smith')
    expect(row!.sponsorParty).toBe('D')
    const history = JSON.parse(row!.history!)
    expect(history[0]).toMatchObject({ date: '2026-01-10', action: 'Introduced in House', chamber: 'lower' })
  })

  it('runs AI when bill matches keywords', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).toHaveBeenCalled()
    const row = await db.select().from(bills).get()
    expect(row!.tenantSummary).toBe('Directly affects absentee ballot handling')
    expect(row!.relevanceScore).toBe(8)
    expect(row!.aiProcessedAt).not.toBeNull()
  })

  // Regression guard for the retired preset gate. AI used to be gated on
  // `shouldRunAi && activePreset`, using a preset's existence as a proxy for "this
  // tenant is configured enough to run AI". Reinstating any such gate would stop AI
  // for every tenant with no error at all — bills would simply arrive with no
  // summary, no tags, and no relevance score. Nothing here configures a preset or an
  // ai_context: the interpolated defaults must carry the run on their own.
  it('runs AI with no preset concept and no ai_context configured', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).toHaveBeenCalled()
    const row = await db.select().from(bills).get()
    expect(row!.tenantSummary).toBe('Directly affects absentee ballot handling')
    expect(row!.aiProcessedAt).not.toBeNull()
  })

  it('skips AI when bill does not match keywords', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['zoning']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
    const row = await db.select().from(bills).get()
    expect(row!.externalId).toBe(BILL_ID)
    expect(row!.tenantSummary).toBeNull()
    expect(row!.relevanceScore).toBeNull()
  })

  // Empty keywords mean "match nothing", the same rule central applies when it
  // decides which bills to fan out. Previously empty meant match-everything here,
  // which would stamp match_type='keyword' on a keyword-less tenant.
  it('skips AI when no keywords are configured (empty means match nothing)', async () => {
    const db = getDb(env.DB)
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
    const row = await db.select().from(bills).get()
    expect(row!.matchType).toBeNull()
  })

  it('skips reprocessing when providerUpdatedAt is unchanged', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    vi.clearAllMocks()
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
  })

  it('reprocesses when forceMetadata is true even if updatedAt unchanged', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    vi.clearAllMocks()
    const forceMsg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, forceMetadata: true }
    await processCentralNotification(forceMsg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).toHaveBeenCalled()
  })

  it('forceAI bypasses keyword gate', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['zoning']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, forceAI: true }
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).toHaveBeenCalled()
  })

  // ── new_match_at + bill_matched feed event (set once on first keyword analysis) ──

  it('sets new_match_at and writes one bill_matched event on first keyword analysis', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)

    const row = await db.select().from(bills).get()
    expect(row!.matchType).toBe('keyword')
    expect(row!.newMatchAt).not.toBeNull()
    const events = await db.select().from(feedEvents).where(eq(feedEvents.type, 'bill_matched')).all()
    expect(events).toHaveLength(1)
    expect(events[0].billId).toBe(row!.id)
    expect(events[0].userId).toBe('system')
  })

  it('does not re-set new_match_at or re-emit bill_matched on re-analysis (forceAI)', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const first = (await db.select().from(bills).get())!.newMatchAt

    // forceAI re-runs the model (aiResult truthy again) but new_match_at is already set.
    const forceMsg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, forceAI: true }
    await processCentralNotification(forceMsg, testEnv as any, db)

    const row = await db.select().from(bills).get()
    expect(row!.newMatchAt).toBe(first)
    const events = await db.select().from(feedEvents).where(eq(feedEvents.type, 'bill_matched')).all()
    expect(events).toHaveLength(1)
  })

  it('does not set new_match_at for manual bills', async () => {
    const db = getDb(env.DB)
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, matchType: 'manual' }
    await processCentralNotification(msg, testEnv as any, db)
    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).toHaveBeenCalled() // manual still runs AI
    const row = await db.select().from(bills).get()
    expect(row!.matchType).toBe('manual')
    expect(row!.newMatchAt).toBeNull()
    const events = await db.select().from(feedEvents).where(eq(feedEvents.type, 'bill_matched')).all()
    expect(events).toHaveLength(0)
  })

  it('does not set new_match_at when AI is skipped for lack of text', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    // Central bill with no texts and no textHash → hasFullText false → AI skipped.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
      return Promise.resolve({ ok: true, json: async () => ({ ...fakeCentralBill, texts: [], textHash: null }) })
    }))
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)

    const { processBill } = await import('../../src/lib/llm')
    expect(processBill).not.toHaveBeenCalled()
    const row = await db.select().from(bills).get()
    expect(row!.newMatchAt).toBeNull()
    const events = await db.select().from(feedEvents).where(eq(feedEvents.type, 'bill_matched')).all()
    expect(events).toHaveLength(0)
  })

  // ── ai_skip_reason: permanent AI failures (migration 0039) ──────────────────
  //
  // When the AI provider rejects input non-retryably (e.g. Gemini's 1000-page PDF cap),
  // the processor records `aiSkipReason = 'pdf_too_large'` and `lastAiTextHash` so that:
  //   1. Future cron ticks early-return without re-fetching text
  //   2. A successful run on a new text version clears the reason
  //   3. `forceAI` always bypasses the skip

  // A transient failure — provider outage, exhausted AI Gateway credits, bad token —
  // is NOT a property of the document, so it must not set aiSkipReason. But leaving
  // every field null makes it indistinguishable from "never queued", which is exactly
  // how 42 bills sat silently after an AI Gateway credit balance hit zero: the logs
  // showed 402s while the database showed nothing at all.
  it('records ai_error and ai_attempted_at on a transient failure, without claiming a permanent skip', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })

    const { processBill } = await import('../../src/lib/llm')
    ;(processBill as any).mockRejectedValueOnce(
      Object.assign(new Error('Insufficient wholesale credits.'), { status: 402 })
    )

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)

    const row = await db.select().from(bills).get()
    expect(row!.aiError).toContain('Insufficient wholesale credits')
    expect(row!.aiAttemptedAt).not.toBeNull()
    // Not a document problem, so no permanent skip and no summary.
    expect(row!.aiSkipReason).toBeNull()
    expect(row!.aiProcessedAt).toBeNull()
    expect(row!.tenantSummary).toBeNull()
    // Crucially, no lastAiTextHash: recording it would dedup the retry away and
    // make a billing outage permanent for these bills.
    expect(row!.lastAiTextHash).toBeNull()
  })

  it('records ai_skip_reason on Gemini page-limit error and leaves ai_processed_at null', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })

    const { processBill } = await import('../../src/lib/llm')
    ;(processBill as any).mockRejectedValueOnce(
      Object.assign(new Error('The document contains 3100 pages which exceeds the supported page limit of 1000.'), { status: 400 })
    )

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)

    const row = await db.select().from(bills).get()
    expect(row!.aiSkipReason).toBe('pdf_too_large')
    expect(row!.aiProcessedAt).toBeNull()
    expect(row!.tenantSummary).toBeNull()
    // lastAiTextHash gets set to dedup future runs on the same text
    expect(row!.lastAiTextHash).toBe('hash-abc123')
  })

  // Regression: an unreadable stored document used to leave BOTH ai_processed_at
  // and ai_skip_reason null, which is the same state as "never attempted". 40
  // Indiana bills sat in that state looking untouched while every one of them had
  // actually failed — the state site had served an HTML shell under a .pdf URL.
  it('records ai_skip_reason when Gemini cannot parse the document at all', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })

    const { processBill } = await import('../../src/lib/llm')
    // Verbatim shape of the error observed from the tenant worker.
    ;(processBill as any).mockRejectedValueOnce(
      Object.assign(
        new Error('{"error":{"code":400,"message":"The document has no pages.","status":"INVALID_ARGUMENT"}}'),
        { status: 400 },
      )
    )

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)

    const row = await db.select().from(bills).get()
    expect(row!.aiSkipReason).toBe('unreadable_document')
    expect(row!.aiProcessedAt).toBeNull()
    expect(row!.tenantSummary).toBeNull()
  })

  it('transient (non-permanent) AI errors throw AiShedError so processQueue can retry delivery', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })

    const { processBill } = await import('../../src/lib/llm')
    // 503 is transient — processor throws AiShedError so processQueue can call message.retry()
    ;(processBill as any).mockRejectedValueOnce(
      Object.assign(new Error('Service Unavailable'), { status: 503 })
    )

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    // AiShedError propagates out of processCentralNotification; processQueue catches it and
    // calls message.retry({ delaySeconds: 60 }) for flex-tier sheds
    await expect(processCentralNotification(msg, testEnv as any, db)).rejects.toMatchObject({
      message: 'AI gateway shed — will redeliver',
      delaySeconds: 60,
    })
    // No bill row is written — the upsert happens after AI, so the message will be re-delivered in full
  })

  it('skips re-processing on next message when ai_skip_reason is set (early-return dedup)', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })

    const { processBill } = await import('../../src/lib/llm')
    ;(processBill as any).mockRejectedValueOnce(
      Object.assign(new Error('exceeds the supported page limit of 1000'), { status: 400 })
    )

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    expect((processBill as any).mock.calls.length).toBe(1)

    // Second fire of the same message: same providerUpdatedAt, same textHash,
    // ai_skip_reason is set → early-return without calling AI
    await processCentralNotification(msg, testEnv as any, db)
    expect((processBill as any).mock.calls.length).toBe(1)
  })

  it('forceAI bypasses ai_skip_reason and re-attempts', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })

    const { processBill } = await import('../../src/lib/llm')
    ;(processBill as any).mockRejectedValueOnce(
      Object.assign(new Error('exceeds the supported page limit of 1000'), { status: 400 })
    )

    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    expect((await db.select().from(bills).get())!.aiSkipReason).toBe('pdf_too_large')

    // Admin force-runs — should call AI again. Mock now returns success.
    const forceMsg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, forceAI: true }
    await processCentralNotification(forceMsg, testEnv as any, db)

    const row = await db.select().from(bills).get()
    expect(row!.aiSkipReason).toBeNull() // cleared on success
    expect(row!.aiProcessedAt).not.toBeNull()
    expect(row!.tenantSummary).toBe('Directly affects absentee ballot handling')
  })

  it('populates bill_texts from texts array', async () => {
    const db = getDb(env.DB)
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const bill = await db.select().from(bills).get()
    const texts = await db.select().from(billTexts).where(eq(billTexts.billId, bill!.id)).all()
    expect(texts).toHaveLength(1)
    expect(texts[0].docId).toBe('ver-uuid-001')
    expect(texts[0].type).toBe('Introduced')
    expect(texts[0].mime).toBe('text/html')
    expect(texts[0].stateLink).toBe('https://legisinfo.ri.gov/HB100.html')
  })

  it('emits bill_updated feed event when AI-processed bill has status change', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>New text</p>' }) })
      return Promise.resolve({ ok: true, json: async () => ({
        ...fakeCentralBill,
        status: 'in_committee',
        updatedAt: '2026-02-01T00:00:00Z',
        textHash: 'hash-new',
      }) })
    }))

    const msgWithChanges: TenantQueueMessage = {
      ...msg,
      changes: [{ changeType: 'status', oldValue: 'introduced', newValue: 'in_committee', detail: null, detectedAt: '2026-02-01T00:00:00Z' }],
    }
    await processCentralNotification(msgWithChanges, testEnv as any, db)
    const events = await db.select().from(feedEvents).all()
    const updateEvent = events.find(e => e.type === 'bill_updated')
    expect(updateEvent).toBeDefined()
    const meta = JSON.parse(updateEvent!.metadata)
    expect(meta.changes.some((c: { changeType: string }) => c.changeType === 'status')).toBe(true)
  })

  it('writes lastAiTextDocId to the newest-by-date text version after AI runs', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>Bill text</p>' }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({
        ...fakeCentralBill,
        texts: [
          { docId: 'OLDER', note: 'Introduced', date: '2026-04-01', links: [{ url: 'https://x/older.html', mediaType: 'text/html' }] },
          { docId: 'NEWER', note: 'Amended', date: '2026-05-15', links: [{ url: 'https://x/newer.html', mediaType: 'text/html' }] },
        ],
      }) })
    }))
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const row = await db.select().from(bills).get()
    expect(row!.aiProcessedAt).not.toBeNull()
    expect(row!.lastAiTextDocId).toBe('NEWER')
  })

  it('skips AI when central has no texts (safety net)', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) {
        return Promise.resolve({ ok: true, status: 404, json: async () => ({}) })
      }
      return Promise.resolve({ ok: true, json: async () => ({
        ...fakeCentralBill,
        texts: [],
        textHash: null,
      }) })
    }))
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    const row = await db.select().from(bills).get()
    // Defense in depth: with no full text in central, AI must not run.
    // The UI's "no AI yet" state is driven by aiProcessedAt being null.
    expect(row!.aiProcessedAt).toBeNull()
    expect(row!.lastAiTextDocId).toBeNull()
  })

  it('does not emit bill_updated for non-AI bill metadata changes', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['zoning']) })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID }
    await processCentralNotification(msg, testEnv as any, db)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/text')) return Promise.resolve({ ok: true, status: 404, json: async () => ({}) })
      return Promise.resolve({ ok: true, json: async () => ({
        ...fakeCentralBill, status: 'in_committee', updatedAt: '2026-02-01T00:00:00Z',
      }) })
    }))
    const forceMsg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, forceMetadata: true }
    await processCentralNotification(forceMsg, testEnv as any, db)
    const events = await db.select().from(feedEvents).all()
    expect(events.filter(e => e.type === 'bill_updated')).toHaveLength(0)
  })
})
