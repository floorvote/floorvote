import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { clearDb } from '../helpers/migrations'
import { queueMissingTexts, MISSING_TEXTS_PER_RUN } from '../../src/cron/missing-texts'

// An ingest writes a bill's detail and text rows before it downloads the texts.
// One that dies in between leaves texts that no attempt ever reached, on a bill
// whose detail reads as current, so no later sync revisits it. The hourly sweep
// queues those bills to download their texts, with no getBill call.

const db = () => drizzle(env.DB, { schema })
const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)

beforeEach(async () => {
  await clearDb()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
  await db().insert(schema.tenants).values({ tenantId: 'test-tenant', name: 'test-tenant', active: true, stateCoverage: '["WI"]' })
  await db().insert(schema.sessions).values({
    sessionId: 1, state: 'WI', stateId: 0, yearStart: 2025, yearEnd: 2026,
    sessionName: '2025', sessionTitle: '2025', sessionTag: '',
    prefile: 0, sineDie: 0, prior: 0, special: 0,
  })
})
afterEach(() => { vi.useRealTimers() })

async function seedBill(billId: number, opts: {
  matchType?: 'keyword' | 'manual' | null
  fetchRequestedAt?: string | null
  linked?: boolean
  textsFetchedAt?: string | null
  texts?: Array<{ r2Key?: string | null; attemptedAt?: string | null; stateLink?: string | null }>
} = {}) {
  await db().insert(schema.bills).values({
    billId, sessionId: 1, state: 'WI', stateId: 0, billNumber: `AB${billId}`, title: `Bill ${billId}`,
    changeHash: 'h', detailHash: 'h', status: 1,
    textsFetchedAt: opts.textsFetchedAt === undefined ? HOURS_AGO(5) : opts.textsFetchedAt,
  })
  if (opts.linked !== false) {
    await db().insert(schema.billTenants).values({
      billId, tenantId: 'test-tenant', matchType: opts.matchType === undefined ? 'manual' : opts.matchType,
      fetchRequestedAt: opts.fetchRequestedAt ?? null,
    })
  }
  const texts = opts.texts ?? [{}]
  for (const [i, t] of texts.entries()) {
    await db().insert(schema.billTexts).values({
      docId: billId * 10 + i, billId, date: '2026-02-06', type: 'Introduced', typeId: 1,
      mime: 'application/pdf', mimeId: 2,
      stateLink: t.stateLink === undefined ? `https://example.test/${billId}-${i}.pdf` : t.stateLink,
      r2Key: t.r2Key ?? null,
      fetchAttemptedAt: t.attemptedAt ?? null,
    })
  }
}

async function run() {
  const sendBatch = vi.fn().mockResolvedValue(undefined)
  const mockEnv = { ...(env as any), INGESTOR_QUEUE: { sendBatch, send: vi.fn() } }
  const result = await queueMissingTexts(mockEnv, db())
  const messages = sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))
  return { result, messages, sendBatch }
}

describe('queueMissingTexts', () => {
  it('queues a tracked bill whose text was never attempted, to download it without a getBill call', async () => {
    await seedBill(1012)
    const { messages, result } = await run()
    expect(messages).toEqual([{ billId: 1012, forceMetadata: true, skipFetch: true }])
    expect(result).toEqual({ queued: 1 })
  })

  it('queues a bill linked by keyword as well as by hand', async () => {
    await seedBill(1, { matchType: 'keyword' })
    await seedBill(2, { matchType: 'manual' })
    expect((await run()).messages.map(m => m.billId).sort()).toEqual([1, 2])
  })

  it('leaves out a bill whose text is stored', async () => {
    await seedBill(3, { texts: [{ r2Key: 'bills/legiscan-3/texts/30.pdf' }] })
    const { messages, sendBatch } = await run()
    expect(messages).toEqual([])
    expect(sendBatch).not.toHaveBeenCalled()
  })

  it('leaves out a text an attempt already reached, even one that failed', async () => {
    // A failed attempt records its error; retrying it is the admin route's job,
    // since its fallback may spend a provider call.
    await seedBill(4, { texts: [{ attemptedAt: HOURS_AGO(30) }] })
    expect((await run()).messages).toEqual([])
  })

  it('leaves out a bill no instance tracks', async () => {
    await seedBill(5, { matchType: null })
    await seedBill(6, { linked: false })
    expect((await run()).messages).toEqual([])
  })

  it('queues a lead an instance reads without tracking it, while its request is recent', async () => {
    // A companion group's lead: the instance shows its text on the tracked bill's page.
    await seedBill(16, { matchType: null, fetchRequestedAt: HOURS_AGO(2) })
    expect((await run()).messages).toEqual([{ billId: 16, forceMetadata: true, skipFetch: true }])
  })

  it('leaves out a lead whose request has lapsed', async () => {
    await seedBill(17, { matchType: null, fetchRequestedAt: HOURS_AGO(24 * 100) })
    expect((await run()).messages).toEqual([])
  })

  it('leaves out a text with no state link, which nothing can download', async () => {
    await seedBill(7, { texts: [{ stateLink: null }] })
    expect((await run()).messages).toEqual([])
  })

  it('leaves alone a bill whose ingest may still be running', async () => {
    // A fresh ingest writes the text rows moments before it downloads them.
    await seedBill(8, { textsFetchedAt: HOURS_AGO(0.25) })
    expect((await run()).messages).toEqual([])
  })

  it('leaves alone a bill whose first ingest has not stamped its texts as fetched', async () => {
    // A quiet first full ingest stamps texts_fetched_at only once it has written everything.
    await seedBill(9, { textsFetchedAt: null })
    expect((await run()).messages).toEqual([])
  })

  it('stamps the texts it queues as attempted, and only those', async () => {
    await seedBill(13, { texts: [{}, { r2Key: 'bills/legiscan-13/texts/131.pdf' }] })
    await seedBill(14, { matchType: null })
    await run()
    const rows = await db().select().from(schema.billTexts).all()
    const attempted = Object.fromEntries(rows.map(r => [r.docId, r.fetchAttemptedAt]))
    expect(attempted[130]).toBe('2026-10-24 12:00:00')
    expect(attempted[131]).toBeNull()
    expect(attempted[140]).toBeNull()
  })

  it('does not queue a swept bill again when its download never finished', async () => {
    // A download that hangs or errors before stamping its attempt must not
    // bring the bill back every hour.
    await seedBill(15)
    expect((await run()).messages.map(m => m.billId)).toEqual([15])
    vi.setSystemTime(new Date('2026-10-24T13:00:00Z'))
    expect((await run()).messages).toEqual([])
  })

  it('reads the unattempted texts through a partial index', async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT bill_id FROM bill_texts WHERE r2_key IS NULL AND fetch_attempted_at IS NULL AND state_link IS NOT NULL`).all()
    expect(JSON.stringify(plan.results)).toContain('idx_bill_texts_unattempted')
  })

  it('queues a bill once when it has several texts missing, or one missing beside one stored', async () => {
    await seedBill(10, { texts: [{}, {}] })
    await seedBill(11, { texts: [{ r2Key: 'bills/legiscan-11/texts/110.pdf' }, {}] })
    expect((await run()).messages.map(m => m.billId).sort()).toEqual([10, 11])
  })

  it('queues one bill once when several instances track it', async () => {
    await seedBill(12)
    await db().insert(schema.tenants).values({ tenantId: 'other', name: 'other', active: true, stateCoverage: '["WI"]' })
    await db().insert(schema.billTenants).values({ billId: 12, tenantId: 'other', matchType: 'keyword' })
    expect((await run()).messages).toEqual([{ billId: 12, forceMetadata: true, skipFetch: true }])
  })

  it(`queues at most ${MISSING_TEXTS_PER_RUN} bills a run, the rest on later runs`, async () => {
    for (let i = 0; i < MISSING_TEXTS_PER_RUN + 5; i++) await seedBill(100 + i)
    const { messages, result } = await run()
    expect(messages).toHaveLength(MISSING_TEXTS_PER_RUN)
    expect(result).toEqual({ queued: MISSING_TEXTS_PER_RUN })
    expect(new Set(messages.map(m => m.billId)).size).toBe(MISSING_TEXTS_PER_RUN)
  })

  it('queues nothing when there is nothing to fill', async () => {
    const { result, sendBatch } = await run()
    expect(result).toEqual({ queued: 0 })
    expect(sendBatch).not.toHaveBeenCalled()
  })
})

describe('the hourly tick', () => {
  async function tick(cron: string) {
    const sendBatch = vi.fn().mockResolvedValue(undefined)
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})) }, passThroughOnException() {} } as unknown as ExecutionContext
    const { default: worker } = await import('../../src/index')
    await worker.scheduled!(
      { cron, scheduledTime: Date.now() } as ScheduledController,
      { ...(env as any), ALERT_EMAILS: '', INGESTOR_QUEUE: { sendBatch, send: vi.fn() } },
      ctx,
    )
    await Promise.all(pending)
    return sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)).filter((m: any) => m.skipFetch)
  }

  it('queues the missing texts on the hourly cron', async () => {
    await seedBill(1012)
    expect(await tick('0 * * * *')).toEqual([{ billId: 1012, forceMetadata: true, skipFetch: true }])
  })

  it('leaves them to the hourly cron on the engagement pull tick', async () => {
    const { ENGAGEMENT_PULL_CRON } = await import('../../src/cron/engagement-pull')
    await seedBill(1012)
    expect(await tick(ENGAGEMENT_PULL_CRON)).toEqual([])
  })
})
