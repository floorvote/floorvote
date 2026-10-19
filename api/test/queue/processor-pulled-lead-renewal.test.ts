import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { clearDb, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills } from '../../src/db/schema'
import { toDbTs } from '../../src/lib/dbTime'

// Central keeps ingesting a pulled companion's new texts only while this
// instance's request for it is recent (#801), and an instance asks with
// fetch-bills only while the bill has no text. So while a pulled bill leads a
// group with a tracked bill, a tracked member's delivery renews the request
// (POST /tenants/renew-fetch-requests), at most once a week per lead. A lead
// pulled before #801 holds its text and was never asked for again, so its
// first renewal is on the first such delivery. Invented bills A190 (tracked)
// and S1713 (pulled, the lead, analyzed on its newest text).

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn() }
})

const RENEW = '/tenants/renew-fetch-requests/test-org'
const fetchMock = vi.fn()

function centralBill(handle: string) {
  const [number, rank, related, relatedId] = handle === 'legiscan:190'
    ? ['A190', 100, 'S1713', 1713] as const
    : ['S1713', 300, 'A190', 190] as const
  return {
    billId: handle, sessionId: '1', state: 'NJ', number, title: `${number} title`, abstract: null, status: 'Introduced',
    statusRank: rank, statusDate: null, lastAction: null, updatedAt: '2026-10-01T00:00:00Z', stateUrl: null,
    // Central holds the lead's text, as it does for a lead pulled before #801.
    ...(handle === 'legiscan:1713'
      ? { textHash: 'hash-7001', textR2Key: 'bills/legiscan:1713.html',
          texts: [{ docId: '7001', note: 'Introduced', date: '2026-01-01', links: [{ url: 'https://example.gov/7001.html', mediaType: 'text/html' }] }] }
      : { textHash: null, textR2Key: null, texts: [] }),
    actions: [], sponsors: [], votes: [],
    relatedBills: [{ identifier: related, sastBillId: relatedId, kind: 'identical', session: '1', relationType: 'same-as' }],
  }
}

function testEnv() {
  return { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test', BILL_QUEUE: { send: vi.fn() } } as never
}

async function deliver(handle: string) {
  await processCentralNotification({ tenantId: 'test-org', billId: handle, metadataOnly: true }, testEnv(), getDb(env.DB))
}

const renewals = () => fetchMock.mock.calls.filter(c => String(c[0]).includes(RENEW)).map(c => JSON.parse(c[1].body))
const setBill = (id: string, values: Partial<typeof bills.$inferInsert>) => getDb(env.DB).update(bills).set(values).where(eq(bills.id, id))

describe("a tracked member's delivery renews the request for its group's pulled lead", () => {
  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/tenants/')) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
      const handle = decodeURIComponent(String(url).split('/bills/')[1] ?? '')
      return { ok: true, json: async () => centralBill(handle) }
    })
    vi.stubGlobal('fetch', fetchMock)
    // A lead pulled before #801: it holds its text and its analysis read it, so nothing asks central for it again.
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190', matchType: 'keyword', statusRank: 100,
      tenantSummary: 'A190 summary', aiProcessedAt: '2026-09-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713', matchType: null, statusRank: 300,
      tenantSummary: 'S1713 summary', aiProcessedAt: '2026-08-01 00:00:00', textR2Key: 'bills/legiscan:1713.html' })
    await seedBillText('a190', { docId: '6001', date: '2026-01-01' })
    await seedBillText('b1713', { docId: '7001', date: '2026-01-01' })
    await setBill('b1713', { lastAiTextDocId: '7001' })
    await setBill('a190', { groupKey: 'a190' })
    await setBill('b1713', { groupKey: 'a190' })
  })

  it('renews it on the first delivery, though the lead holds its text and was never asked for again', async () => {
    await deliver('legiscan:190')
    expect(renewals()).toEqual([{ billIds: [1713] }])
  })

  it('renews it at most once a week', async () => {
    await deliver('legiscan:190')
    await deliver('legiscan:190')
    expect(renewals()).toHaveLength(1)
    await setBill('b1713', { fetchRenewedAt: toDbTs(new Date(Date.now() - 6 * 86400_000)) })
    await deliver('legiscan:190')
    expect(renewals()).toHaveLength(1)
    await setBill('b1713', { fetchRenewedAt: toDbTs(new Date(Date.now() - 8 * 86400_000)) })
    await deliver('legiscan:190')
    expect(renewals()).toHaveLength(2)
  })

  it("renews it on the lead's own delivery, with no delivery of its tracked member", async () => {
    await deliver('legiscan:1713')
    expect(renewals()).toEqual([{ billIds: [1713] }])
  })

  it("holds the lead's own delivery to the same weekly claim", async () => {
    await deliver('legiscan:190')
    await deliver('legiscan:1713')
    expect(renewals()).toHaveLength(1)
  })

  it('reports a refused renewal as an error naming the bill', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes(RENEW)) return { ok: false, status: 403, json: async () => ({}), text: async () => '' }
      if (String(url).includes('/tenants/')) return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' }
      const handle = decodeURIComponent(String(url).split('/bills/')[1] ?? '')
      return { ok: true, json: async () => centralBill(handle) }
    })
    await deliver('legiscan:190')
    expect(error.mock.calls.map(c => c.join(' '))).toContainEqual(expect.stringMatching(/renew-fetch-requests.*403.*legiscan:1713/))
    error.mockRestore()
  })

  it('renews nothing once the lead is tracked', async () => {
    await setBill('b1713', { matchType: 'keyword' })
    await deliver('legiscan:190')
    expect(renewals()).toEqual([])
  })
})
