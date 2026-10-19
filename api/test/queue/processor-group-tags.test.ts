import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { associationConfig } from '../../src/db/schema'

// A tag filter tests each bill's group tags (migration 0103): the tags of its
// companion group's current analysis (its lead bill's, migration 0113), or its
// own for a bill in no group. Here each bill analyzed more recently is also
// further along, so the most recently analyzed bill in a group leads. Stored on every bill, they must follow each
// change to an analysis or to a group: a new analysis, a join, a split, and a
// recompute that rekeys several bills at once.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn() }
})

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }

type Related = { identifier: string; sastBillId: number; kind: string }

// What central serves for each bill, keyed by its handle.
const central = new Map<string, { number: string; relatedBills: Related[]; updatedAt?: string }>()

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
    statusRank: RANK[handle] ?? 0,
    statusDate: null,
    updatedAt: b.updatedAt ?? '2026-10-01T00:00:00Z',
    stateUrl: null,
    textHash: `hash-${handle}`,
    textR2Key: `bills/${handle}.html`,
    texts: [{ docId: `doc-${handle}`, note: 'Introduced', date: '2026-01-01', links: [{ url: `https://njleg.gov/${handle}.html`, mediaType: 'text/html' }] }],
    actions: [],
    sponsors: [],
    votes: [],
    relatedBills: b.relatedBills.map(r => ({ ...r, session: '1', relationType: 'same-as' })),
  }
}

// How far along each bill is, so a group's lead is its most recently analyzed bill.
const RANK: Record<string, number> = { 'legiscan:190': 100, 'legiscan:1713': 200, 'legiscan:1714': 300 }

const identical = (identifier: string, sastBillId: number): Related => ({ identifier, sastBillId, kind: 'identical' })

async function deliver(handle: string) {
  await processCentralNotification({ tenantId: 'test-org', billId: handle, metadataOnly: true }, testEnv as never, getDb(env.DB))
}

// A new analysis of the bill, which sets its tags.
async function analyze(handle: string, tags: string[]) {
  const llm = await import('../../src/lib/llm')
  vi.mocked(llm.processBill).mockResolvedValueOnce({ summary: 'AI summary', tags, relevanceScore: 5, affectedCitations: [] })
  await processCentralNotification({ tenantId: 'test-org', billId: handle, matchType: 'keyword', forceAI: true }, testEnv as never, getDb(env.DB))
}

async function groupTags(): Promise<Record<string, string[]>> {
  const { results } = await env.DB.prepare('SELECT id, group_tags FROM bills ORDER BY id').all<{ id: string; group_tags: string }>()
  return Object.fromEntries(results.map(r => [r.id, JSON.parse(r.group_tags) as string[]]))
}

describe('group tags follow analyses and groups', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    central.clear()
    await getDb(env.DB).insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }, { name: 'Housing' }]) })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/text')) return { ok: true, json: async () => ({ type: 'html', content: '<p>text</p>' }) }
      const handle = decodeURIComponent(String(url).split('/bills/')[1] ?? '')
      return { ok: true, json: async () => centralBill(handle) }
    }))
    // Analyzed bills the instance already tracks, by handle: A190 longest ago, S1714 most recently.
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190', tags: ['Labor'], tenantSummary: 'x', aiProcessedAt: '2026-09-01 00:00:00', statusRank: 100 })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713', tags: ['Energy'], tenantSummary: 'x', aiProcessedAt: '2026-09-02 00:00:00', statusRank: 200 })
    await seedBill({ id: 'c1714', billNumber: 'S1714', state: 'NJ', externalId: 'legiscan:1714', tags: ['Housing'], tenantSummary: 'x', aiProcessedAt: '2026-09-03 00:00:00', statusRank: 300 })
  })

  it("gives both bills the newer analysis's tags when they join", async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    const tags = await groupTags()
    expect([tags.a190, tags.b1713]).toEqual([['Energy'], ['Energy']])
    expect(tags.c1714).toEqual(['Housing'])
  })

  it('gives every bill of a group the tags of a new analysis of its current bill', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    await analyze('legiscan:1713', ['Labor', 'Housing'])
    const tags = await groupTags()
    expect([tags.a190, tags.b1713]).toEqual([['Labor', 'Housing'], ['Labor', 'Housing']])
  })

  it('gives each bill its own tags back when the group splits', async () => {
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190)] })
    await deliver('legiscan:1713')
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [], updatedAt: '2026-10-02T00:00:00Z' })
    await deliver('legiscan:1713')
    const tags = await groupTags()
    expect([tags.a190, tags.b1713]).toEqual([['Labor'], ['Energy']])
  })

  it('settles the tags of a chain that one recompute groups at once', async () => {
    // S1713 names both, so one guarded batch writes all three keys.
    central.set('legiscan:1713', { number: 'S1713', relatedBills: [identical('A190', 190), identical('S1714', 1714)] })
    await deliver('legiscan:1713')
    const tags = await groupTags()
    expect([tags.a190, tags.b1713, tags.c1714]).toEqual([['Housing'], ['Housing'], ['Housing']])
  })

  it('settles the tags of both parts when a recompute splits a chain and rekeys what remains', async () => {
    central.set('legiscan:190', { number: 'A190', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1714', { number: 'S1714', relatedBills: [identical('S1713', 1713)] })
    await deliver('legiscan:190')
    await deliver('legiscan:1714')
    // A190 now leaves, and S1713 and S1714 take a new key.
    central.set('legiscan:190', { number: 'A190', relatedBills: [], updatedAt: '2026-10-02T00:00:00Z' })
    await deliver('legiscan:190')
    const tags = await groupTags()
    expect([tags.a190, tags.b1713, tags.c1714]).toEqual([['Labor'], ['Housing'], ['Housing']])
  })

  it('takes the tags of a bill that leaves off the bills that stay, whose key is unchanged', async () => {
    central.set('legiscan:190', { number: 'A190', relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1714', { number: 'S1714', relatedBills: [identical('S1713', 1713)] })
    await deliver('legiscan:190')
    await deliver('legiscan:1714')
    // S1714, the lead, leaves. A190 and S1713 keep their key, so only S1714's row is written.
    central.set('legiscan:1714', { number: 'S1714', relatedBills: [], updatedAt: '2026-10-02T00:00:00Z' })
    await deliver('legiscan:1714')
    const tags = await groupTags()
    expect([tags.a190, tags.b1713, tags.c1714]).toEqual([['Energy'], ['Energy'], ['Housing']])
  })
})
