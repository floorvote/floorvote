import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill, seedUser, seedSession } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { runDigest } from '../../src/lib/digest'
import { associationConfig, bills, feedEvents } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// A companion that didn't match the instance's keywords is analyzed anyway once
// it's in a group with a tracked bill, so every bill in a group has its own
// summary and text. It joins by group membership, not keyword match: it stays
// untracked (match_type null), and never becomes a new match.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn() }
})

type Related = { identifier: string; sastBillId: number; kind: string }

// What central serves for each bill, keyed by its handle.
const central = new Map<string, { number: string; relatedBills: Related[]; text?: boolean; updatedAt?: string; lastAction?: string }>()

function centralBill(handle: string) {
  const b = central.get(handle)!
  return {
    billId: handle,
    sessionId: '1',
    state: 'NJ',
    number: b.number,
    title: `${b.number} title`,
    abstract: null,
    status: 'Introduced',
    statusDate: null,
    lastAction: b.lastAction ?? null,
    updatedAt: b.updatedAt ?? '2026-10-01T00:00:00Z',
    stateUrl: null,
    textHash: b.text ? `hash-${handle}` : null,
    textR2Key: b.text ? `bills/${handle}.html` : null,
    texts: b.text ? [{ docId: `doc-${handle}`, note: 'Introduced', date: '2026-01-01', links: [{ url: `https://njleg.gov/${handle}.html`, mediaType: 'text/html' }] }] : [],
    actions: [],
    sponsors: [],
    votes: [],
    relatedBills: b.relatedBills.map(r => ({ ...r, session: '1', relationType: 'same-as' })),
  }
}

const identical = (identifier: string, sastBillId: number): Related => ({ identifier, sastBillId, kind: 'identical' })

// The instance's own queue, and what the instance asked central for.
const queued: TenantQueueMessage[] = []
const fetchRequests: { path: string; body: { billIds: number[] } }[] = []
const queue = { send: vi.fn(async (m: TenantQueueMessage) => { queued.push(m) }) }

function testEnv(extra: Record<string, unknown> = {}) {
  return { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test', BILL_QUEUE: queue, ...extra } as never
}

async function deliver(handle: string, flags: Partial<TenantQueueMessage> = { metadataOnly: true }, extra: Record<string, unknown> = {}) {
  await processCentralNotification({ tenantId: 'test-org', billId: handle, ...flags }, testEnv(extra), getDb(env.DB))
}

/** Run the instance's own queue, as the consumer does, until it's empty. */
async function drain(extra: Record<string, unknown> = {}) {
  while (queued.length > 0) await processCentralNotification(queued.shift()!, testEnv(extra), getDb(env.DB))
}

async function billRow(id: string) {
  return (await getDb(env.DB).select().from(bills).where(eq(bills.id, id)).get())!
}

/** What each test below starts from: the companion was analyzed. Without it, "doesn't count" would hold of a bill nothing was done to. */
async function expectCompanionAnalyzed() {
  expect((await billRow('b1713')).aiProcessedAt).not.toBeNull()
}

describe('companions that didn\'t match are analyzed through their group', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    central.clear()
    queued.length = 0
    fetchRequests.length = 0
    const llm = await import('../../src/lib/llm')
    vi.mocked(llm.processBill).mockResolvedValue({ summary: 'AI summary', tags: [], relevanceScore: 5, affectedCitations: [] })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/tenants/fetch-bills/')) {
        fetchRequests.push({ path: String(url), body: JSON.parse(String(init?.body)) })
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
      }
      if (String(url).includes('/text')) return { ok: true, json: async () => ({ type: 'html', content: '<p>text</p>' }) }
      const handle = decodeURIComponent(String(url).split('/bills/')[1] ?? '')
      return { ok: true, json: async () => centralBill(handle) }
    }))
    // A190 matched the keywords and is analyzed. S1713 is its identical companion, which didn't match.
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190', matchType: 'keyword', tenantSummary: 'A190 summary', aiProcessedAt: '2026-09-01 00:00:00', newMatchAt: '2026-09-01 00:00:00', triagedAt: '2026-09-02 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713', matchType: null })
    central.set('legiscan:190', { number: 'A190', text: true, relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1713', { number: 'S1713', text: true, relatedBills: [identical('A190', 190)] })
  })

  describe('a companion that didn\'t match is fetched and analyzed once it\'s in a group', () => {
    it('analyzes the companion when central already holds its text', async () => {
      await getDb(env.DB).update(bills).set({ textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await deliver('legiscan:190')
      await drain()
      const llm = await import('../../src/lib/llm')
      const companion = await billRow('b1713')
      expect(companion.aiProcessedAt).not.toBeNull()
      expect(companion.tenantSummary).toBe('AI summary')
      expect(vi.mocked(llm.processBill)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(llm.processBill).mock.calls[0][0].billNumber).toBe('S1713')
    })

    it('asks central to fetch a companion whose text the instance doesn\'t hold', async () => {
      await deliver('legiscan:190')
      expect(fetchRequests.map(r => [r.path, r.body.billIds])).toEqual([['https://central.test/api/tenants/fetch-bills/test-org', [1713]]])
      expect(queued).toEqual([])
      expect((await billRow('b1713')).aiProcessedAt).toBeNull()
    })

    it('analyzes the companion when the fetch arrives', async () => {
      await deliver('legiscan:190')
      // Central ingested S1713 and sent it on, with its text and no match for this instance.
      await deliver('legiscan:1713', { matchType: null })
      await drain()
      const companion = await billRow('b1713')
      expect(companion.aiProcessedAt).not.toBeNull()
      expect(companion.tenantSummary).toBe('AI summary')
    })

    it('doesn\'t ask again for the ingest it asked for, even if that arrives with no text', async () => {
      central.set('legiscan:1713', { number: 'S1713', text: false, relatedBills: [identical('A190', 190)] })
      await deliver('legiscan:190')
      fetchRequests.length = 0
      await deliver('legiscan:1713', { matchType: null })
      expect(fetchRequests).toEqual([])
      expect(queued).toEqual([])
    })

    it('asks again when the companion changes at central, since it may have text now', async () => {
      await deliver('legiscan:190')
      fetchRequests.length = 0
      central.set('legiscan:1713', { number: 'S1713', text: false, relatedBills: [identical('A190', 190)], updatedAt: '2026-10-02T00:00:00Z' })
      await deliver('legiscan:1713', { stubOnly: true })
      expect(fetchRequests.map(r => r.body.billIds)).toEqual([[1713]])
    })

    it('leaves alone a group with no tracked bill', async () => {
      await getDb(env.DB).update(bills).set({ textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await getDb(env.DB).update(bills).set({ matchType: null }).where(eq(bills.id, 'a190'))
      await deliver('legiscan:190')
      expect(fetchRequests).toEqual([])
      expect(queued).toEqual([])
    })

    it('leaves alone a bill with no companion', async () => {
      central.set('legiscan:190', { number: 'A190', text: true, relatedBills: [] })
      await deliver('legiscan:190')
      expect(fetchRequests).toEqual([])
      expect(queued).toEqual([])
    })

    it('queues one analysis, however often the group is delivered while it waits', async () => {
      await getDb(env.DB).update(bills).set({ textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await deliver('legiscan:190')
      await deliver('legiscan:190')
      await deliver('legiscan:1713')
      expect(queued).toHaveLength(1)
      expect(queued[0]).toMatchObject({ tenantId: 'test-org', billId: 'legiscan:1713', groupAnalysis: true })
    })

    it('queues one analysis when two deliveries of the group race', async () => {
      await getDb(env.DB).update(bills).set({ textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await Promise.all([deliver('legiscan:190'), deliver('legiscan:190'), deliver('legiscan:190')])
      expect(queued).toHaveLength(1)
    })

    it('leaves a tracked bill to its own analysis, whatever its group', async () => {
      await getDb(env.DB).update(bills).set({ matchType: 'keyword', textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await deliver('legiscan:190')
      expect(fetchRequests).toEqual([])
      expect(queued).toEqual([])
    })

    it('leaves alone a companion that is already analyzed', async () => {
      await getDb(env.DB).update(bills).set({ aiProcessedAt: '2026-09-03 00:00:00', tenantSummary: 'Its own', textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await deliver('legiscan:190')
      expect(fetchRequests).toEqual([])
      expect(queued).toEqual([])
    })

    it('never pulls on a demo instance, which never calls the model', async () => {
      await getDb(env.DB).update(bills).set({ textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await deliver('legiscan:190', { metadataOnly: true }, { DEMO_MODE: 'true' })
      expect(fetchRequests).toEqual([])
      expect(queued).toEqual([])
    })
  })

  describe('it doesn\'t count as a new match', () => {
    // A190 is a tracked bill that isn't a new match (a manual add), so the group has none to show: any
    // new match the surfaces below report would be S1713's.
    beforeEach(async () => {
      await getDb(env.DB).update(bills).set({ textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await getDb(env.DB).update(bills).set({ matchType: 'manual', newMatchAt: null, triagedAt: null }).where(eq(bills.id, 'a190'))
      await deliver('legiscan:190')
      await drain()
    })

    it('stays untracked and unflagged even when its own text matches the keywords', async () => {
      // The bill would be a keyword match on its own. Joining through its group isn't one.
      await getDb(env.DB).update(bills).set({ tenantSummary: null, aiProcessedAt: null, lastAiTextHash: null }).where(eq(bills.id, 'b1713'))
      await getDb(env.DB).insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['S1713']) })
      await deliver('legiscan:190')
      await drain()
      const companion = await billRow('b1713')
      expect(companion.aiProcessedAt).not.toBeNull()
      expect(companion.matchType).toBeNull()
      expect(companion.newMatchAt).toBeNull()
    })

    it('isn\'t in the triage list', async () => {
      await expectCompanionAnalyzed()
      const token = await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))
      const res = await SELF.fetch('http://localhost/api/bills?newMatches=1', { headers: { Cookie: `session=${token}` } })
      expect((await res.json() as { bills: unknown[]; pagination: { total: number } })).toMatchObject({ bills: [], pagination: { total: 0 } })
    })

    it('isn\'t in the N new chip', async () => {
      await expectCompanionAnalyzed()
      const token = await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))
      const res = await SELF.fetch('http://localhost/api/bills/facets', { headers: { Cookie: `session=${token}` } })
      expect((await res.json() as { newMatchesCount: number }).newMatchesCount).toBe(0)
    })

    it('isn\'t in the dashboard count', async () => {
      await expectCompanionAnalyzed()
      const token = await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))
      const res = await SELF.fetch('http://localhost/api/stats', { headers: { Cookie: `session=${token}` } })
      expect((await res.json() as { newMatchesCount: number }).newMatchesCount).toBe(0)
    })

    it('writes no new-match feed event', async () => {
      await expectCompanionAnalyzed()
      const events = await getDb(env.DB).select().from(feedEvents).where(eq(feedEvents.type, 'bill_matched')).all()
      expect(events).toEqual([])
    })

    it('isn\'t in the digest', async () => {
      await expectCompanionAnalyzed()
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'modules', value: JSON.stringify({ 'email-digest': true }) })
      await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))
      const sent: unknown[] = []
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }) }))
      await runDigest(env as never, db)
      expect(sent).toEqual([])
    })
  })

  describe('a split companion stays analyzed and untracked unless it matches on its own', () => {
    beforeEach(async () => {
      await getDb(env.DB).update(bills).set({ textR2Key: 'bills/legiscan:1713.html' }).where(eq(bills.id, 'b1713'))
      await deliver('legiscan:190')
      await drain()
    })

    it('keeps its analysis and isn\'t tracked once the group splits', async () => {
      await expectCompanionAnalyzed()
      central.set('legiscan:190', { number: 'A190', text: true, relatedBills: [], updatedAt: '2026-10-02T00:00:00Z' })
      central.set('legiscan:1713', { number: 'S1713', text: true, relatedBills: [], updatedAt: '2026-10-02T00:00:00Z' })
      await deliver('legiscan:190')
      await deliver('legiscan:1713', { metadataOnly: true })
      const split = await billRow('b1713')
      expect(split.groupKey).toBeNull()
      expect(split.aiProcessedAt).not.toBeNull()
      expect(split.tenantSummary).toBe('AI summary')
      expect(split.matchType).toBeNull()
      expect((await billRow('a190')).matchType).toBe('keyword')
    })

    it('is tracked once central says it matches on its own', async () => {
      await expectCompanionAnalyzed()
      central.set('legiscan:190', { number: 'A190', text: true, relatedBills: [], updatedAt: '2026-10-02T00:00:00Z' })
      await deliver('legiscan:190')
      // What central sends when the bill newly matches the keywords: its match type, and the analysis forced.
      await deliver('legiscan:1713', { matchType: 'keyword', forceAI: true })
      const companion = await billRow('b1713')
      expect(companion.matchType).toBe('keyword')
      expect(companion.newMatchAt).not.toBeNull()
    })
  })

  describe('an analyzed companion keeps its metadata current', () => {
    it('takes a stub delivery\'s update while it\'s in a group with a tracked bill', async () => {
      await getDb(env.DB).update(bills).set({ aiProcessedAt: '2026-09-03 00:00:00', tenantSummary: 'Its own', textR2Key: 'bills/legiscan:1713.html', lastAction: 'Introduced' }).where(eq(bills.id, 'b1713'))
      await deliver('legiscan:190')
      central.set('legiscan:1713', { number: 'S1713', text: true, relatedBills: [identical('A190', 190)], updatedAt: '2026-10-02T00:00:00Z', lastAction: 'Passed Senate' })
      await deliver('legiscan:1713', { stubOnly: true })
      expect((await billRow('b1713')).lastAction).toBe('Passed Senate')
    })

    it('still leaves an analyzed bill that is in no group alone, as before', async () => {
      await seedBill({ id: 'solo', billNumber: 'S9', state: 'NJ', externalId: 'legiscan:9', matchType: null, tenantSummary: 'Its own', aiProcessedAt: '2026-09-03 00:00:00', lastAction: 'Introduced' })
      central.set('legiscan:9', { number: 'S9', text: true, relatedBills: [], lastAction: 'Passed Senate' })
      await deliver('legiscan:9', { stubOnly: true })
      expect((await billRow('solo')).lastAction).toBe('Introduced')
    })
  })
})
