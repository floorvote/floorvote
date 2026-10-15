import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { resetDb, applyMigrations } from '../helpers'
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
  actions: [], sponsors: [], votes: [], relatedBills: [],
}
const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }

describe('processor: tag team events', () => {
  const db = () => getDb(env.DB)

  async function analyze(tags: string[]) {
    const llm = await import('../../src/lib/llm')
    vi.mocked(llm.processBill).mockResolvedValueOnce({ summary: 'AI summary', tags, relevanceScore: 5, affectedCitations: [] })
    const msg: TenantQueueMessage = { tenantId: 'test-org', billId: BILL_ID, matchType: 'keyword', forceAI: true }
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
})
