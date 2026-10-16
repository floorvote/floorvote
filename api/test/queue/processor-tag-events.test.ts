import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { associationConfig, bills, teamEvents } from '../../src/db/schema'
import { rowidOf } from '../../src/db/rowid'
import type { TenantQueueMessage } from '../../src/types'

// Tags are a team field, and only the AI analysis sets them. Each analysis
// that changes them records a structured team event with no actor, so a
// future bill history can show when FloorVote retagged a bill.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn() }
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

describe('processor: tag team events', () => {
  const db = () => getDb(env.DB)

  async function analyze(tags: string[], matchType: 'keyword' | null = 'keyword') {
    const llm = await import('../../src/lib/llm')
    vi.mocked(llm.processBill).mockResolvedValueOnce({ summary: 'AI summary', tags, relevanceScore: 5, affectedCitations: [] })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, matchType, forceAI: true }
    await processCentralNotification(msg, testEnv as never, db())
  }
  async function tagEvents() {
    const bill = await db().select({ id: bills.id }).from(bills).where(eq(bills.externalId, BILL_ID)).get()
    const rows = await db().select().from(teamEvents)
      .where(and(eq(teamEvents.billId, bill!.id), eq(teamEvents.type, 'field_changed')))
      .orderBy(teamEvents.createdAt, rowidOf(teamEvents)).all()
    return rows.map(r => ({ actorUserId: r.actorUserId, ...JSON.parse(r.metadata) as Record<string, unknown> }))
  }

  beforeEach(async () => {
    centralBill.relatedBills = []
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    await db().insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }]) })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      url.includes('/text')
        ? Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>text</p>' }) })
        : Promise.resolve({ ok: true, json: async () => centralBill }),
    ))
  })

  it('records the tags an analysis sets, with no actor', async () => {
    await analyze(['Energy'])
    expect(await tagEvents()).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] }])
  })

  it('records a re-analysis that changes the tags, and none that keeps them', async () => {
    await analyze(['Energy'])
    await analyze(['Energy'])
    await analyze(['Energy', 'Labor'])
    expect((await tagEvents()).slice(1)).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: ['Energy'], new: ['Energy', 'Labor'] }])
  })

  describe('in a companion group', () => {
    // S77 is A4242's identical companion, already in the instance and tracked.
    beforeEach(async () => {
      centralBill.relatedBills = [{ identifier: 'S77', sastBillId: 77, kind: 'identical', session: 'nj:2026', relationType: 'same-as' }]
      await seedBill({ id: 'comp', billNumber: 'S77', state: 'NJ', externalId: 'legiscan:77', matchType: 'keyword' })
    })

    it("records the group's tags before and after, not the bill's own, for a tracked bill", async () => {
      await analyze(['Energy'])
      const own = await db().select({ id: bills.id, groupKey: bills.groupKey }).from(bills).where(eq(bills.externalId, BILL_ID)).get()
      expect(own!.groupKey).not.toBeNull()
      // The tracked companion is analyzed later, so the group shows its tags.
      await db().update(bills).set({ tags: JSON.stringify(['Labor']), tenantSummary: 'S77 summary', aiProcessedAt: '2026-01-01 00:00:00' }).where(eq(bills.id, 'comp'))
      await db().update(bills).set({ aiProcessedAt: '2025-12-01 00:00:00' }).where(eq(bills.id, own!.id))
      // A4242's own tags don't change, but the group's do, from S77's to A4242's.
      await analyze(['Energy'])
      expect((await tagEvents()).slice(1)).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: ['Labor'], new: ['Energy'] }])
    })

    it("records the analysis of a bill that didn't match when the group has no tracked analysis", async () => {
      // Grouped first, with no analysis of either bill.
      await processCentralNotification({ tenantId: 'test-org', billId: BILL_ID, matchType: null, metadataOnly: true }, testEnv as never, db())
      expect((await db().select({ groupKey: bills.groupKey }).from(bills).where(eq(bills.externalId, BILL_ID)).get())!.groupKey).not.toBeNull()
      await analyze(['Energy'], null)
      expect(await tagEvents()).toEqual([{ actorUserId: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] }])
    })

    it("records nothing for a bill that didn't match when the group's tracked analysis keeps its tags", async () => {
      await db().update(bills).set({ tags: JSON.stringify(['Labor']), tenantSummary: 'S77 summary', aiProcessedAt: '2026-01-01 00:00:00' }).where(eq(bills.id, 'comp'))
      await processCentralNotification({ tenantId: 'test-org', billId: BILL_ID, matchType: null, metadataOnly: true }, testEnv as never, db())
      await analyze(['Energy'], null)
      expect(await tagEvents()).toEqual([])
    })
  })
})
