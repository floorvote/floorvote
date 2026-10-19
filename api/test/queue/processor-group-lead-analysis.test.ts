import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills } from '../../src/db/schema'
import { MAX_COMPANION_ANALYSES_PER_DELIVERY } from '../../src/lib/companionAnalysis'
import { toDbTs } from '../../src/lib/dbTime'
import type { TenantQueueMessage } from '../../src/types'

// A companion group shows its lead bill's summary (see **Lead bill** in
// CONTEXT.md). A tracked lead is analyzed again when its own delivery brings a
// new text. A pulled lead (one that didn't match) isn't tracked, so nothing
// re-analyzed it: a delivery of any member of its group now queues its
// analysis, as a group analysis, when its newest text isn't the one its
// analysis read. The per-delivery cap, the heal's age floor, and the claim on
// `ai_attempted_at` bound it as they bound the first analysis of a pulled
// companion. Invented bills A190 (tracked) and S1713 (pulled, the lead).

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn() }
})

type Related = { identifier: string; sastBillId: number; kind: string }
type Text = { docId: string; date: string }
type Served = { number: string; relatedBills: Related[]; statusRank: number; texts: Text[]; textHash?: string }

// What central serves for each bill, keyed by its handle.
const central = new Map<string, Served>()

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
    statusRank: b.statusRank,
    statusDate: null,
    lastAction: null,
    updatedAt: '2026-10-01T00:00:00Z',
    stateUrl: null,
    textHash: b.texts.length > 0 ? (b.textHash ?? `hash-${handle}-${b.texts.map(t => t.docId).join('-')}`) : null,
    textR2Key: b.texts.length > 0 ? `bills/${handle}.html` : null,
    texts: b.texts.map(t => ({ docId: t.docId, note: 'Introduced', date: t.date, links: [{ url: `https://example.gov/${t.docId}.html`, mediaType: 'text/html' }] })),
    actions: [],
    sponsors: [],
    votes: [],
    relatedBills: b.relatedBills.map(r => ({ ...r, session: '1', relationType: 'same-as' })),
  }
}

const identical = (identifier: string, sastBillId: number): Related => ({ identifier, sastBillId, kind: 'identical' })

const queued: TenantQueueMessage[] = []
const queue = { send: vi.fn(async (m: TenantQueueMessage) => { queued.push(m) }) }

function testEnv(extra: Record<string, unknown> = {}) {
  return { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test', BILL_QUEUE: queue, ...extra } as never
}

async function deliver(handle: string, flags: Partial<TenantQueueMessage> = { metadataOnly: true }, extra: Record<string, unknown> = {}) {
  await processCentralNotification({ tenantId: 'test-org', billId: handle, ...flags }, testEnv(extra), getDb(env.DB))
}

async function drain() {
  for (let i = 0; queued.length > 0; i++) {
    // A loop would never empty the queue.
    expect(i).toBeLessThan(50)
    await processCentralNotification(queued.shift()!, testEnv(), getDb(env.DB))
  }
}

async function billRow(id: string) {
  return (await getDb(env.DB).select().from(bills).where(eq(bills.id, id)).get())!
}

const setBill = (id: string, values: Partial<typeof bills.$inferInsert>) => getDb(env.DB).update(bills).set(values).where(eq(bills.id, id))
const leadQueued = () => queued.filter(m => m.billId === 'legiscan:1713')
const analyzedBills = async () => vi.mocked((await import('../../src/lib/llm')).processBill).mock.calls.map(c => c[0].billNumber)

describe("a pulled lead is analyzed again when its newest text isn't the one it read", () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    central.clear()
    queued.length = 0
    const llm = await import('../../src/lib/llm')
    vi.mocked(llm.processBill).mockResolvedValue({ summary: 'New summary', tags: [], relevanceScore: 5, affectedCitations: [] })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/tenants/fetch-bills/')) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
      if (String(url).includes('/text')) return { ok: true, json: async () => ({ type: 'html', content: '<p>text</p>' }) }
      const handle = decodeURIComponent(String(url).split('/bills/')[1] ?? '')
      return { ok: true, json: async () => centralBill(handle) }
    }))
    // A190 is tracked and analyzed. S1713, its identical companion, didn't match, is further along, and so
    // leads. It was analyzed on its first text, 7001, and central has since stored a newer one, 7002.
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190', matchType: 'keyword', statusRank: 100,
      tenantSummary: 'A190 summary', aiProcessedAt: '2026-09-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713', matchType: null, statusRank: 300,
      tenantSummary: 'S1713 first summary', aiProcessedAt: '2026-08-01 00:00:00', textR2Key: 'bills/legiscan:1713.html' })
    await setBill('b1713', { lastAiTextDocId: '7001', lastAiTextHash: 'hash-old' })
    await seedBillText('a190', { docId: '6001', date: '2026-01-01' })
    await seedBillText('b1713', { docId: '7001', date: '2026-01-01' })
    await seedBillText('b1713', { docId: '7002', date: '2026-05-01' })
    central.set('legiscan:190', { number: 'A190', statusRank: 100, texts: [{ docId: '6001', date: '2026-01-01' }], relatedBills: [identical('S1713', 1713)] })
    central.set('legiscan:1713', { number: 'S1713', statusRank: 300, texts: [{ docId: '7001', date: '2026-01-01' }, { docId: '7002', date: '2026-05-01' }], relatedBills: [identical('A190', 190)] })
    await setBill('a190', { groupKey: 'a190' })
    await setBill('b1713', { groupKey: 'a190' })
  })

  it("queues the lead's analysis, as a group analysis, when another member is delivered", async () => {
    await deliver('legiscan:190')
    expect(leadQueued()).toEqual([{ tenantId: 'test-org', billId: 'legiscan:1713', groupAnalysis: true }])
  })

  it('analyzes the lead on its newest text, which the group then shows', async () => {
    await deliver('legiscan:190')
    await drain()
    expect(await analyzedBills()).toEqual(['S1713'])
    expect(await billRow('b1713')).toMatchObject({ tenantSummary: 'New summary', lastAiTextDocId: '7002', matchType: null, aiAttemptedAt: null })
  })

  it("queues it on the lead's own delivery of the new text too, since that delivery doesn't analyze a bill that didn't match", async () => {
    await deliver('legiscan:1713', {})
    expect(leadQueued()).toEqual([{ tenantId: 'test-org', billId: 'legiscan:1713', groupAnalysis: true }])
    await drain()
    expect((await billRow('b1713')).lastAiTextDocId).toBe('7002')
  })

  it("doesn't queue it when the lead's analysis read its newest text", async () => {
    await setBill('b1713', { lastAiTextDocId: '7002' })
    await deliver('legiscan:190')
    expect(queued).toEqual([])
  })

  it("doesn't queue a member that isn't the lead, whatever its texts", async () => {
    // A190 is now furthest along, and current. S1713's text is newer than its analysis, but it doesn't lead.
    await setBill('a190', { statusRank: 400, lastAiTextDocId: '6001' })
    central.set('legiscan:190', { ...central.get('legiscan:190')!, statusRank: 400 })
    await deliver('legiscan:190')
    expect(queued).toEqual([])
  })

  it("leaves a tracked lead to its own delivery, which analyzes a new text itself", async () => {
    await setBill('b1713', { matchType: 'keyword' })
    await deliver('legiscan:190')
    expect(queued).toEqual([])
  })

  it('queues it once, however often the group is delivered while it waits', async () => {
    await deliver('legiscan:190')
    await deliver('legiscan:190')
    await deliver('legiscan:1713')
    expect(leadQueued()).toHaveLength(1)
  })

  it("doesn't queue it again while an earlier attempt is within the heal's age floor", async () => {
    await setBill('b1713', { aiAttemptedAt: toDbTs(new Date(Date.now() - 10 * 60 * 1000)) })
    await deliver('legiscan:190')
    expect(queued).toEqual([])
  })

  it('queues it again once an earlier attempt is older than the floor', async () => {
    await setBill('b1713', { aiAttemptedAt: toDbTs(new Date(Date.now() - 2 * 60 * 60 * 1000)) })
    await deliver('legiscan:190')
    expect(leadQueued()).toHaveLength(1)
  })

  it("doesn't loop when the analysis is deduplicated because the text is the same", async () => {
    // Central's text hash is the one the analysis read, though the newest document's id differs.
    central.set('legiscan:1713', { ...central.get('legiscan:1713')!, textHash: 'hash-old' })
    await deliver('legiscan:190')
    await drain()
    expect(await analyzedBills()).toEqual([])
    await deliver('legiscan:190')
    expect(queued).toEqual([])
  })

  it('never queues on a demo instance, which never calls the model', async () => {
    await deliver('legiscan:190', { metadataOnly: true }, { DEMO_MODE: 'true' })
    expect(queued).toEqual([])
  })

  it('leaves alone a group with no tracked bill', async () => {
    await setBill('a190', { matchType: null })
    await deliver('legiscan:190')
    expect(queued).toEqual([])
  })

  describe('the per-delivery cap', () => {
    const handleOf = (i: number) => `legiscan:${3000 + i}`
    async function waitingCompanions(count: number) {
      for (let i = 0; i < count; i++) {
        await seedBill({ id: `c${i}`, billNumber: `C${i}`, state: 'NJ', externalId: handleOf(i), matchType: null, statusRank: 100, textR2Key: `bills/${handleOf(i)}.html` })
        await setBill(`c${i}`, { groupKey: 'a190' })
        central.set(handleOf(i), { number: `C${i}`, statusRank: 100, texts: [{ docId: `${8000 + i}`, date: '2026-01-01' }], relatedBills: [identical('A190', 190)] })
      }
      // Central lists them as A190's identical companions, so its delivery keeps them in the group.
      const a = central.get('legiscan:190')!
      central.set('legiscan:190', { ...a, relatedBills: [...a.relatedBills, ...Array.from({ length: count }, (_, i) => identical(`C${i}`, 3000 + i))] })
    }

    it("counts the lead's analysis against the cap, and queues the lead first", async () => {
      await waitingCompanions(MAX_COMPANION_ANALYSES_PER_DELIVERY + 3)
      await deliver('legiscan:190')
      expect(queued).toHaveLength(MAX_COMPANION_ANALYSES_PER_DELIVERY)
      expect(queued[0]).toMatchObject({ billId: 'legiscan:1713', groupAnalysis: true })
    })

    it("doesn't queue the lead while the cap's worth of analyses are queued or running", async () => {
      await waitingCompanions(MAX_COMPANION_ANALYSES_PER_DELIVERY)
      const recent = toDbTs(new Date(Date.now() - 5 * 60 * 1000))
      for (let i = 0; i < MAX_COMPANION_ANALYSES_PER_DELIVERY; i++) await setBill(`c${i}`, { aiAttemptedAt: recent })
      await deliver('legiscan:190')
      expect(queued).toEqual([])
    })
  })
})
