import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { eq } from 'drizzle-orm'
import { bills, billTexts, feedEvents, associationConfig } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// A full delivery never puts an older provider version over a newer one. Each
// delivery reads central's copy when it runs, so when two deliveries of a bill
// overlap, the one that read the older copy (its AI call ran in between) can
// finish after the other stored a newer version. It must leave the newer fields and stamp alone and
// write no feed events of its own.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({
      summary: 'Summary of the bill text',
      tags: ['Elections'],
      relevanceScore: 8,
    }),
  }
})

const BILL_ID = 'bill:906'
const V1 = '2026-05-21T00:00:00Z'
// A is the older version, B the newer one.
const A = '2026-06-02T08:30:00Z'
const B = '2026-06-09T16:45:00Z'

function centralBill(over: Record<string, unknown> = {}) {
  return {
    billId: BILL_ID,
    sessionId: 'ri:2026',
    sessionName: '2026 Regular Session',
    state: 'RI',
    number: 'HB 906',
    title: 'Election Administration Act',
    abstract: 'An act relating to election administration',
    status: 'introduced',
    statusDate: '2026-05-01',
    updatedAt: V1,
    stateUrl: 'https://state.example/HB906',
    textHash: 'hash-one',
    textR2Key: 'bills/906/ver-1.html',
    texts: [{ docId: 'doc-1', note: 'Introduced', date: '2026-05-01', links: [{ url: 'https://state.example/HB906.html', mediaType: 'text/html' }] }],
    actions: [{ description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 }],
    sponsors: [{ name: 'Jane Smith', party: 'D', role: 'Representative', primary: true, personId: 'p1', url: null }],
    votes: [],
    relatedBills: [],
    ...over,
  }
}

const versionA = () => centralBill({
  updatedAt: A,
  title: 'Election Administration Act, as amended in committee',
  status: 'in committee',
  textHash: 'hash-a',
  textR2Key: 'bills/906/ver-a.html',
  texts: [{ docId: 'doc-a', note: 'Committee draft', date: '2026-06-01', links: [{ url: 'https://state.example/HB906-a.html', mediaType: 'text/html' }] }],
  actions: [
    { description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 },
    { description: 'Referred to Judiciary', date: '2026-06-01', chamber: 'lower', classification: [], order: 2 },
  ],
})
const versionB = () => centralBill({
  updatedAt: B,
  title: 'Election Administration Act, as passed',
  status: 'passed',
  textHash: 'hash-b',
  textR2Key: 'bills/906/ver-b.html',
  texts: [{ docId: 'doc-b', note: 'Engrossed', date: '2026-06-08', links: [{ url: 'https://state.example/HB906-b.html', mediaType: 'text/html' }] }],
  actions: [
    { description: 'Introduced in House', date: '2026-05-01', chamber: 'lower', classification: [], order: 1 },
    { description: 'Referred to Judiciary', date: '2026-06-01', chamber: 'lower', classification: [], order: 2 },
    { description: 'Passed House', date: '2026-06-08', chamber: 'lower', classification: [], order: 3 },
  ],
})

const testEnv = { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' }
// What central sends for a change it detected: the feed's bill_updated event comes from `changes`.
const changed: TenantQueueMessage = {
  tenantId: 'test-org',
  billId: BILL_ID,
  changes: [{ changeType: 'status_change', oldValue: 'introduced', newValue: 'changed', detail: null, detectedAt: '2026-06-09 17:00:00' }],
}

/** Central serves this version of the bill. */
function centralServes(bill: ReturnType<typeof centralBill>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/text')) {
      return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: `<p>Text ${bill.textHash}</p>`, docId: bill.texts[0].docId, textHash: bill.textHash }) })
    }
    return Promise.resolve({ ok: true, json: async () => bill })
  }))
}
const deliver = (msg: TenantQueueMessage) => processCentralNotification(msg, testEnv as never, getDb(env.DB))
const row = () => getDb(env.DB).select().from(bills).where(eq(bills.externalId, BILL_ID)).get()
const events = () => getDb(env.DB).select({ type: feedEvents.type }).from(feedEvents).all()
const textDocs = async () => (await getDb(env.DB).select({ docId: billTexts.docId }).from(billTexts).all()).map(t => t.docId).sort()
async function processBillMock() {
  const { processBill } = await import('../../src/lib/llm')
  return vi.mocked(processBill)
}

beforeEach(async () => {
  await clearDb()
  vi.clearAllMocks()
  await getDb(env.DB).insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(['election']) })
})

describe('a full delivery never stores an older provider version', () => {
  it('keeps version B when version A, which is older, is delivered after it', async () => {
    centralServes(versionB())
    await deliver(changed)
    const afterB = await row()
    expect(afterB!.providerUpdatedAt).toBe(B)
    const eventsAfterB = await events()
    const analysesAfterB = (await processBillMock()).mock.calls.length

    centralServes(versionA())
    await deliver(changed)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe(B)
    expect(stored!.title).toBe('Election Administration Act, as passed')
    expect(stored!.status).toBe('passed')
    expect(stored!.lastAction).toBe('Passed House')
    expect(stored!.textR2Key).toBe('bills/906/ver-b.html')
    expect(stored!.lastAiTextHash).toBe('hash-b')
    expect(stored!.centralSyncedAt).toBe(afterB!.centralSyncedAt)
    expect(await textDocs()).toEqual(['doc-b'])
    // No bill_updated (nor any other) event from A, and no analysis of the older text.
    expect(await events()).toEqual(eventsAfterB)
    expect((await processBillMock()).mock.calls.length).toBe(analysesAfterB)
  })

  it('writes nothing when B is stored while A is being analyzed', async () => {
    centralServes(centralBill())
    await deliver({ tenantId: 'test-org', billId: BILL_ID })
    const eventsBefore = await events()

    // A's analysis runs while another delivery stores B: the check before the
    // analysis passed, so only the write itself can refuse A.
    const processBill = await processBillMock()
    processBill.mockImplementationOnce(async () => {
      await getDb(env.DB).update(bills)
        .set({ providerUpdatedAt: B, title: 'Election Administration Act, as passed', tenantSummary: 'Summary of B' })
        .where(eq(bills.externalId, BILL_ID))
      const billId = (await row())!.id
      await env.DB.prepare('INSERT INTO bill_subjects (bill_id, subject_name, state) VALUES (?, ?, ?)')
        .bind(billId, 'New subject', 'RI').run()
      await env.DB.prepare('INSERT INTO bill_committees (bill_id, committee_id, state, name, is_current) VALUES (?, ?, ?, ?, 1)')
        .bind(billId, 'new-committee', 'RI', 'New committee').run()
      return { summary: 'Summary of A', tags: ['Elections'], relevanceScore: 3 } as never
    })
    centralServes(centralBill({ ...versionA(), subjects: ['Old subject'],
      committee: { committeeId: 'old-committee', name: 'Old committee', chamber: 'H' } }))
    await deliver(changed)
    expect(processBill).toHaveBeenCalledTimes(2)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe(B)
    expect(stored!.title).toBe('Election Administration Act, as passed')
    expect(stored!.tenantSummary).toBe('Summary of B')
    expect(stored!.lastAiTextHash).toBe('hash-one')
    // A's texts were never synced, so the first version's stay.
    expect(await textDocs()).toEqual(['doc-1'])
    expect((await env.DB.prepare('SELECT subject_name FROM bill_subjects').all()).results)
      .toEqual([{ subject_name: 'New subject' }])
    expect((await env.DB.prepare('SELECT committee_id FROM bill_committees').all()).results)
      .toEqual([{ committee_id: 'new-committee' }])
    expect(await events()).toEqual(eventsBefore)
  })

  it('compares the versions as times, across the ISO and space formats', async () => {
    // Same day, B in the space format central writes now, A in ISO. As strings
    // '2026-06-09 16:45:00' sorts before '2026-06-09T08:30:00Z'.
    centralServes(centralBill({ ...versionB(), updatedAt: '2026-06-09 16:45:00' }))
    await deliver(changed)
    const eventsAfterB = await events()

    centralServes(centralBill({ ...versionA(), updatedAt: '2026-06-09T08:30:00Z' }))
    await deliver(changed)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe('2026-06-09 16:45:00')
    expect(stored!.title).toBe('Election Administration Act, as passed')
    expect(await events()).toEqual(eventsAfterB)
  })

  it('still stores a newer version, in either format', async () => {
    centralServes(centralBill({ ...versionA(), updatedAt: '2026-06-09T08:30:00Z' }))
    await deliver(changed)

    centralServes(centralBill({ ...versionB(), updatedAt: '2026-06-09 16:45:00' }))
    await deliver(changed)

    const stored = await row()
    expect(stored!.providerUpdatedAt).toBe('2026-06-09 16:45:00')
    expect(stored!.title).toBe('Election Administration Act, as passed')
    expect((await events()).filter(e => e.type === 'bill_updated')).toHaveLength(1)
  })

  it('lets a stamp it cannot read be overwritten, as before', async () => {
    await getDb(env.DB).insert(bills).values({
      id: 'b-odd', externalId: BILL_ID, billNumber: 'HB 906', title: 'Old title', state: 'RI', status: 'introduced', session: '2026',
      providerUpdatedAt: 'not a time',
    })
    centralServes(versionA())
    await deliver(changed)
    expect((await row())!.providerUpdatedAt).toBe(A)
  })

  it('still writes an equal forced version and chunks its subjects and committees within D1 limits', async () => {
    centralServes(versionB())
    await deliver(changed)
    const processBill = await processBillMock()
    const before = processBill.mock.calls.length
    centralServes(centralBill({ ...versionB(),
      subjects: Array.from({ length: 80 }, (_, i) => `Subject ${i}`),
      referrals: Array.from({ length: 31 }, (_, i) => ({ committeeId: `c${i}`, name: `Committee ${i}`, chamber: 'H' })),
    }))
    await deliver({ ...changed, forceMetadata: true, forceAI: true })
    expect(processBill.mock.calls.length).toBeGreaterThan(before)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bill_subjects').first<{ n: number }>())!.n).toBe(80)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bill_committees').first<{ n: number }>())!.n).toBe(31)
    expect((await row())!.providerUpdatedAt).toBe(B)
  })
})
