import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { clearDb, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'
import { processCentralNotification } from '../../src/queue/processor'
import { BILL_KEYWORD_MATCH_CASES } from '../../../shared/keywordMatchFixtures'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

vi.mock('../../src/cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return {
    ...actual,
    processBill: vi.fn().mockResolvedValue({ summary: 'Summary', tags: [], relevanceScore: 5 }),
  }
})

// The same fixtures central's tests run (central/test/routes/billMatchText.test.ts).
// Each row is a bill plus a keyword list; every instance-side check must agree
// with the row's `expected`, which is what central matches. An empty list is
// left out of the checks that short-circuit on it before matching anything.
const WITH_KEYWORDS = BILL_KEYWORD_MATCH_CASES.filter(c => c.keywords.length > 0)

describe('instance keyword checks read the same text central matches', () => {
  let adminCookie: string

  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
    await getDb(env.DB).delete(associationConfig)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    adminCookie = `session=${await seedSession(adminId)}`
  })

  async function preview(keywords: string[]) {
    const res = await app.request('/api/admin/keyword-resync-preview', {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords }),
    }, env)
    expect(res.status).toBe(200)
    return await res.json() as { wouldAdd: number; wouldDemote: number; wouldProtect: number }
  }

  async function resync(keywords: string[]) {
    await getDb(env.DB).insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(keywords) })
    const sent: { body: { billId: string } }[] = []
    const queue = { sendBatch: vi.fn().mockImplementation(async (msgs: typeof sent) => { sent.push(...msgs) }) }
    const res = await app.request('/api/admin/keyword-resync', {
      method: 'POST', headers: { Cookie: adminCookie },
    }, { ...env, BILL_QUEUE: queue })
    expect(res.status).toBe(200)
    return { body: await res.json() as { queued: number; demoted: number; protectedAsManual: number }, sent }
  }

  describe('POST /admin/keyword-resync-preview', () => {
    it.each(WITH_KEYWORDS)('predicts wouldAdd for an unanalyzed bill: $name', async ({ bill, keywords, expected }) => {
      await seedBill({
        externalId: 'legiscan:1', title: bill.title, abstract: bill.description ?? undefined,
        billNumber: bill.billNumber, matchType: null,
      })
      expect((await preview(keywords)).wouldAdd).toBe(expected ? 1 : 0)
    })

    it.each(WITH_KEYWORDS)('predicts wouldDemote for a matched bill: $name', async ({ bill, keywords, expected }) => {
      await seedBill({
        externalId: 'legiscan:1', title: bill.title, abstract: bill.description ?? undefined,
        billNumber: bill.billNumber, matchType: 'keyword',
      })
      expect((await preview(keywords)).wouldDemote).toBe(expected ? 0 : 1)
    })
  })

  describe('POST /admin/keyword-resync', () => {
    it.each(WITH_KEYWORDS)('queues an unanalyzed bill iff central matches it: $name', async ({ bill, keywords, expected }) => {
      await seedBill({
        externalId: 'legiscan:1', title: bill.title, abstract: bill.description ?? undefined,
        billNumber: bill.billNumber, matchType: null,
      })
      const { body, sent } = await resync(keywords)
      expect(body.queued).toBe(expected ? 1 : 0)
      expect(sent).toHaveLength(expected ? 1 : 0)
    })

    it.each(WITH_KEYWORDS)('demotes a matched bill iff central no longer matches it: $name', async ({ bill, keywords, expected }) => {
      const id = await seedBill({
        externalId: 'legiscan:1', title: bill.title, abstract: bill.description ?? undefined,
        billNumber: bill.billNumber, matchType: 'keyword',
      })
      const { body } = await resync(keywords)
      expect(body.demoted).toBe(expected ? 0 : 1)
      const row = await getDb(env.DB).select({ matchType: bills.matchType }).from(bills).where(eq(bills.id, id)).get()
      expect(row?.matchType).toBe(expected ? 'keyword' : null)
    })
  })

  describe('queue processor', () => {
    it.each(BILL_KEYWORD_MATCH_CASES)('classifies a new bill as central would: $name', async ({ bill, keywords, expected }) => {
      const db = getDb(env.DB)
      await db.insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(keywords) })
      // `abstract` is central's `description` under the instance's name.
      const centralBill = {
        billId: 'legiscan:1', sessionId: 'ri:2026', state: 'RI', number: bill.billNumber,
        title: bill.title, abstract: bill.description, status: 'introduced', statusDate: '2026-01-01',
        updatedAt: '2026-01-10T12:00:00Z', stateUrl: null, textHash: 'h', textR2Key: 'k', providerData: null,
        texts: [{ docId: 'd1', note: 'Introduced', date: '2026-01-01', links: [{ url: 'https://x/1.html', mediaType: 'text/html' }] }],
        documents: [], actions: [], sponsors: [], votes: [], relatedBills: [],
      }
      vi.mocked(centralFetch).mockImplementation(async (_env: unknown, path: string) => {
        if (path.endsWith('/text')) {
          return { ok: true, json: async () => ({ type: 'html', content: '<p>Text</p>' }) } as Response
        }
        return { ok: true, json: async () => centralBill } as Response
      })

      await processCentralNotification(
        { tenantId: 'test-org', billId: 'legiscan:1' },
        { ...env, TENANT_ID: 'test-org', CENTRAL_API_URL: 'https://central.test' } as any,
        db,
      )

      const row = await db.select({ matchType: bills.matchType }).from(bills).get()
      expect(row?.matchType).toBe(expected ? 'keyword' : null)
    })
  })
})
