import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processQueue } from '../../src/queue/processor'
import { associationConfig, bills, teamEvents } from '../../src/db/schema'
import { rowidOf } from '../../src/db/rowid'
import type { TenantQueueMessage } from '../../src/types'

// The tags team event is advisory history. Reading the group's tags before or
// after an analysis, or writing the event, must never fail a delivery whose
// bill upsert has already committed: a retry would redo the work for nothing.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn() }
})

// Real by default; a test makes one call reject to stand in for a failing read or write.
vi.mock('../../src/lib/teamFields', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/teamFields')>()
  return {
    ...actual,
    loadGroupTeamValues: vi.fn(actual.loadGroupTeamValues),
    recordFieldChanges: vi.fn(actual.recordFieldChanges),
  }
})

const BILL_ID = 'legiscan:4242'
const centralBill = {
  billId: BILL_ID, sessionId: 'nj:2026', state: 'NJ', number: 'A4242',
  title: 'An Act concerning energy', abstract: 'Concerns energy.',
  status: 'introduced', statusDate: '2026-01-01', updatedAt: '2026-01-10T12:00:00Z',
  stateUrl: null, textHash: 'hash-v1', textR2Key: 'bills/a4242/v1.html',
  texts: [{ docId: 'doc-4242', note: 'Introduced', date: '2026-01-01', links: [{ url: 'https://njleg.gov/A4242.html', mediaType: 'text/html' }] }],
  actions: [], sponsors: [], votes: [], relatedBills: [] as { identifier: string; sastBillId: number; kind: string; session: string; relationType: string }[],
}
const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }

describe('processor: a failing tags event does not fail the delivery', () => {
  const db = () => getDb(env.DB)
  let errors: ReturnType<typeof vi.spyOn>

  /** Deliver one analysis through the queue handler, and say whether the message was acked or retried. */
  async function deliver(tags: string[], matchType: 'keyword' | null = 'keyword') {
    const llm = await import('../../src/lib/llm')
    vi.mocked(llm.processBill).mockResolvedValueOnce({ summary: 'AI summary', tags, relevanceScore: 5, affectedCitations: [] })
    const body: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, matchType, forceAI: true }
    const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await processQueue([message as never], testEnv as never, db())
    return message
  }
  async function billRow() {
    return db().select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
  }
  async function tagEvents() {
    const bill = await billRow()
    const rows = await db().select().from(teamEvents)
      .where(and(eq(teamEvents.billId, bill!.id), eq(teamEvents.type, 'field_changed')))
      .orderBy(teamEvents.createdAt, rowidOf(teamEvents)).all()
    return rows.map(r => ({ actorUserId: r.actorUserId, ...JSON.parse(r.metadata) as Record<string, unknown> }))
  }
  function expectStoredAndAcked(message: Awaited<ReturnType<typeof deliver>>, row: Awaited<ReturnType<typeof billRow>>) {
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(row).toBeDefined()
    expect(row!.tenantSummary).toBe('AI summary')
    expect(JSON.parse(row!.tags)).toEqual(['Energy'])
    expect(row!.aiProcessedAt).not.toBeNull()
  }
  /** The failure is logged by the tags-event guard, naming the bill. */
  function loggedWithBillId() {
    return errors.mock.calls.some(args => args.some(a => typeof a === 'string' && a.includes(BILL_ID)) && !String(args[0]).startsWith('Queue processing failed'))
  }

  beforeEach(async () => {
    centralBill.relatedBills = []
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    // Back to the real implementations: a test's queued or persistent rejection must not leak into the next.
    const real = await vi.importActual<typeof import('../../src/lib/teamFields')>('../../src/lib/teamFields')
    const tf = await import('../../src/lib/teamFields')
    vi.mocked(tf.loadGroupTeamValues).mockReset().mockImplementation(real.loadGroupTeamValues)
    vi.mocked(tf.recordFieldChanges).mockReset().mockImplementation(real.recordFieldChanges)
    errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await db().insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }]) })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      url.includes('/text')
        ? Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>text</p>' }) })
        : Promise.resolve({ ok: true, json: async () => centralBill }),
    ))
  })
  afterEach(() => {
    errors.mockRestore()
  })

  it('stores the bill and its analysis and acks when the event table is gone', async () => {
    await env.DB.exec('DROP TABLE team_events')
    const message = await deliver(['Energy'])
    expectStoredAndAcked(message, await billRow())
    expect(loggedWithBillId()).toBe(true)
  })

  it('stores the bill and its analysis and acks when the event write throws', async () => {
    const tf = await import('../../src/lib/teamFields')
    vi.mocked(tf.recordFieldChanges).mockRejectedValueOnce(new Error('D1 write failed'))
    const message = await deliver(['Energy'])
    expectStoredAndAcked(message, await billRow())
    expect(await tagEvents()).toEqual([])
    expect(loggedWithBillId()).toBe(true)
  })

  it('stores the bill and its analysis and acks when the read before the upsert fails', async () => {
    const tf = await import('../../src/lib/teamFields')
    vi.mocked(tf.loadGroupTeamValues).mockRejectedValueOnce(new Error('D1 read failed'))
    // A re-analysis, so the before-read runs: it needs an existing bill.
    await seedBill({ externalId: BILL_ID, billNumber: 'A4242', state: 'NJ', matchType: 'keyword' })
    const message = await deliver(['Energy'])
    expectStoredAndAcked(message, await billRow())
    expect(loggedWithBillId()).toBe(true)
  })

  it('stores the bill and its analysis and acks when the read after the upsert fails', async () => {
    const tf = await import('../../src/lib/teamFields')
    await seedBill({ externalId: BILL_ID, billNumber: 'A4242', state: 'NJ', matchType: 'keyword' })
    // The before-read passes through; the after-read is the second call.
    const real = await vi.importActual<typeof import('../../src/lib/teamFields')>('../../src/lib/teamFields')
    vi.mocked(tf.loadGroupTeamValues)
      .mockImplementationOnce(real.loadGroupTeamValues)
      .mockRejectedValueOnce(new Error('D1 read failed'))
    const message = await deliver(['Energy'])
    expectStoredAndAcked(message, await billRow())
    expect(await tagEvents()).toEqual([])
    expect(loggedWithBillId()).toBe(true)
  })

  it('still records the tags event when nothing fails, and acks', async () => {
    const message = await deliver(['Energy'])
    expectStoredAndAcked(message, await billRow())
    expect(await tagEvents()).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] }])
    expect(loggedWithBillId()).toBe(false)
  })

  it('still records a changed re-analysis when nothing fails', async () => {
    await deliver(['Energy'])
    const message = await deliver(['Energy', 'Labor'])
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect((await tagEvents()).slice(1)).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: ['Energy'], new: ['Energy', 'Labor'] }])
  })

  it('writes the event once, not twice, when the delivery is redelivered after it succeeded', async () => {
    await deliver(['Energy'])
    const again = await deliver(['Energy'])
    expect(again.ack).toHaveBeenCalledTimes(1)
    expect(await tagEvents()).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] }])
  })

  it('writes no second event when a redelivery follows a delivery whose event write failed', async () => {
    const tf = await import('../../src/lib/teamFields')
    vi.mocked(tf.recordFieldChanges).mockRejectedValueOnce(new Error('D1 write failed'))
    const first = await deliver(['Energy'])
    expect(first.ack).toHaveBeenCalledTimes(1)
    // The failed event is lost, as the advisory history allows. The redelivery reads the tags already stored, so it has nothing to add.
    const again = await deliver(['Energy'])
    expect(again.ack).toHaveBeenCalledTimes(1)
    expect(await tagEvents()).toEqual([])
  })

  describe('for a bill in a companion group', () => {
    // S77 is A4242's identical companion, already in the instance and tracked.
    beforeEach(async () => {
      centralBill.relatedBills = [{ identifier: 'S77', sastBillId: 77, kind: 'identical', session: 'nj:2026', relationType: 'same-as' }]
      await seedBill({ id: 'comp', billNumber: 'S77', state: 'NJ', externalId: 'legiscan:77', matchType: 'keyword' })
    })

    it('stores the analysis and acks when the group event write fails', async () => {
      const tf = await import('../../src/lib/teamFields')
      vi.mocked(tf.recordFieldChanges).mockRejectedValueOnce(new Error('D1 write failed'))
      const message = await deliver(['Energy'])
      expectStoredAndAcked(message, await billRow())
      expect((await billRow())!.groupKey).not.toBeNull()
      expect(await tagEvents()).toEqual([])
      expect(loggedWithBillId()).toBe(true)
    })

    it('stores the analysis and acks when the group read fails', async () => {
      const tf = await import('../../src/lib/teamFields')
      vi.mocked(tf.loadGroupTeamValues).mockRejectedValue(new Error('D1 read failed'))
      const message = await deliver(['Energy'])
      expectStoredAndAcked(message, await billRow())
      expect(loggedWithBillId()).toBe(true)
    })

    it("still records the group's tags event when nothing fails", async () => {
      const message = await deliver(['Energy'])
      expectStoredAndAcked(message, await billRow())
      expect(await tagEvents()).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] }])
    })
  })
})
