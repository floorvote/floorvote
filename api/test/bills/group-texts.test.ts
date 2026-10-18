import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills, billTexts } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

// A grouped bill's page lists the text versions of every bill in its group,
// grouped by bill (#712), so the page needn't fetch each companion's texts.
// Invented bills throughout.

type GroupText = {
  billId: string
  billNumber: string
  state: string
  sessionSlug: string
  texts: Array<{ docId: string; type: string; date: string; mime: string; stateLink: string | null; altStateLink: string | null }>
}
type Detail = {
  id: string
  texts: Array<{ docId: string }>
  groupTexts?: GroupText[]
  analysisBillId: string
  analysisLastAiTextDocId: string | null
  analysisLastAiText: { docId: string; type: string; date: string } | null
}

describe('GET /api/bills/:id: the texts of the bill\'s companion group', () => {
  let cookie: string
  const db = () => getDb(env.DB)

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    cookie = `session=${await seedSession(await seedUser({ email: 'member@example.com', role: 'member' }))}`
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockResolvedValue(new Response('{}', { status: 200 }))
  })

  async function detail(billId: string): Promise<Detail> {
    const res = await SELF.fetch(`https://x/api/bills/${billId}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as Detail
  }

  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: ids[0] }).where(inArray(bills.id, ids))
  }

  /** A tracked bill with an analysis, and its companion, with texts on both. */
  async function pair() {
    await seedBill({ id: 'a1', billNumber: 'A1715', externalId: 'legiscan:1715', matchType: 'keyword', tenantSummary: 'Shared summary.', aiProcessedAt: '2026-09-01 00:00:00', sessionSlug: '2026' })
    await seedBill({ id: 's1', billNumber: 'S282', externalId: 'legiscan:282', matchType: null, sessionSlug: '2026' })
    await group('a1', 's1')
    await seedBillText('a1', { docId: '8001', type: 'Introduced', date: '2026-01-13', mime: 'text/html' })
    await seedBillText('a1', { docId: '8003', type: 'Chaptered', date: '2026-10-15', mime: 'application/pdf' })
    await seedBillText('a1', { docId: '8002', type: 'Amended', date: '2026-03-19', mime: 'text/html' })
    await seedBillText('s1', { docId: '8101', type: 'Introduced', date: '2026-01-13', mime: 'text/html' })
    await seedBillText('s1', { docId: '8102', type: 'Amended', date: '2026-06-29', mime: 'text/html' })
    await db().update(bills).set({ lastAiTextDocId: '8003' }).where(eq(bills.id, 'a1'))
    await db().update(bills).set({ lastAiTextDocId: '8101' }).where(eq(bills.id, 's1'))
  }

  const byBill = (d: Detail) => Object.fromEntries((d.groupTexts ?? []).map(g => [g.billNumber, g.texts.map(t => t.docId)]))

  it('lists every group bill\'s versions on a companion\'s page, newest first within each bill', async () => {
    await pair()
    const d = await detail('s1')
    expect(byBill(d)).toEqual({ A1715: ['8003', '8002', '8001'], S282: ['8102', '8101'] })
  })

  it('gives the same lists on the analysis bill\'s own page', async () => {
    await pair()
    expect(byBill(await detail('a1'))).toEqual({ A1715: ['8003', '8002', '8001'], S282: ['8102', '8101'] })
  })

  it('gives each bill\'s id, number, state, and session slug for its badge', async () => {
    await pair()
    const d = await detail('s1')
    const a = d.groupTexts!.find(g => g.billNumber === 'A1715')!
    expect(a).toMatchObject({ billId: 'a1', billNumber: 'A1715', state: 'RI', sessionSlug: '2026' })
  })

  it('gives each version\'s docId, type, date, mime, and links, as the page bill\'s own list does', async () => {
    await pair()
    await db().update(billTexts).set({ stateLink: 'https://example.test/a1715.pdf' }).where(eq(billTexts.docId, '8003'))
    const d = await detail('s1')
    const a = d.groupTexts!.find(g => g.billNumber === 'A1715')!
    expect(a.texts[0]).toEqual({ docId: '8003', type: 'Chaptered', date: '2026-10-15', mime: 'application/pdf', stateLink: 'https://example.test/a1715.pdf', altStateLink: null })
  })

  it('leaves the page bill\'s own texts as they were', async () => {
    await pair()
    const d = await detail('s1')
    expect(d.texts.map(t => t.docId)).toEqual(['8102', '8101'])
  })

  it('carries the analysis bill\'s last AI text on a companion\'s page, which is one of the group texts', async () => {
    await pair()
    const d = await detail('s1')
    expect(d.analysisBillId).toBe('a1')
    expect(d.analysisLastAiTextDocId).toBe('8003')
    expect(d.analysisLastAiText).toMatchObject({ docId: '8003', type: 'Chaptered', date: '2026-10-15' })
    expect(d.groupTexts!.find(g => g.billId === 'a1')!.texts.map(t => t.docId)).toContain('8003')
  })

  it('lists a group of three, one entry per bill', async () => {
    await pair()
    await seedBill({ id: 'h1', billNumber: 'H77', externalId: 'legiscan:77', matchType: null, sessionSlug: '2026' })
    await group('a1', 's1', 'h1')
    await seedBillText('h1', { docId: '8201', type: 'Introduced', date: '2026-02-02', mime: 'text/html' })
    const d = await detail('h1')
    expect(byBill(d)).toEqual({ A1715: ['8003', '8002', '8001'], S282: ['8102', '8101'], H77: ['8201'] })
    expect(d.groupTexts).toHaveLength(3)
  })

  it('is the bill\'s own versions alone for a bill in no group', async () => {
    await seedBill({ id: 'solo', billNumber: 'HB 1', externalId: 'legiscan:1', sessionSlug: '2026' })
    await seedBillText('solo', { docId: '9001', type: 'Introduced', date: '2026-01-01' })
    await seedBillText('solo', { docId: '9002', type: 'Engrossed', date: '2026-02-01' })
    const d = await detail('solo')
    expect(byBill(d)).toEqual({ 'HB 1': ['9002', '9001'] })
  })

  it('is empty for a bill in no group with no texts', async () => {
    await seedBill({ id: 'solo', billNumber: 'HB 1', externalId: 'legiscan:1' })
    expect((await detail('solo')).groupTexts).toEqual([])
  })

  it('leaves out a group bill with no texts', async () => {
    await pair()
    await seedBill({ id: 'h1', billNumber: 'H77', externalId: 'legiscan:77', matchType: null })
    await group('a1', 's1', 'h1')
    expect(byBill(await detail('s1'))).toEqual({ A1715: ['8003', '8002', '8001'], S282: ['8102', '8101'] })
  })

  it('lists a companion\'s versions when the page bill has none of its own', async () => {
    await pair()
    await db().delete(billTexts).where(eq(billTexts.billId, 's1'))
    const d = await detail('s1')
    expect(d.texts).toEqual([])
    expect(byBill(d)).toEqual({ A1715: ['8003', '8002', '8001'] })
  })

  it('does not list a bill that was split out of the group', async () => {
    await pair()
    await db().update(bills).set({ groupKey: null }).where(inArray(bills.id, ['a1', 's1']))
    expect(byBill(await detail('s1'))).toEqual({ S282: ['8102', '8101'] })
    expect(byBill(await detail('a1'))).toEqual({ A1715: ['8003', '8002', '8001'] })
  })
})
