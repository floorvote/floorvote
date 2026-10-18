import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

// The bill detail carries a PDF's claim sources (#572): an `unverified` item's
// quote and cited page, so the page can link the claim to that page and show
// the quote. The instance extracts no PDF text, so nothing else about the
// quote is known. The same rules as HTML apply to the pinned document (gone,
// setting off) and to a companion group's page, which shows the analyzed
// member's PDF. Invented bills A100 and S200; no real bill text.

type Item = { claim: string; status: string; quote?: string; page?: number | null; quoteAt?: unknown; matched?: string }
type Detail = {
  analysisBillId: string
  claimSources: null | {
    billId: string
    document: { docId: string; mime: string; type: string }
    items: Item[]
  }
  texts: { docId: string }[]
}

const SUMMARY_A = '- Requires a drop box in each county.\n- Boxes are emptied by two employees.'
const SUMMARY_S = '- Requires a drop box in each county.'

// A stored PDF item, as #569 writes it: unverified, with the model's quote and page.
const pdfItem = (claim: string, quote: string, page?: number | null, status = 'unverified') => ({
  claim, quote, status, claimAt: { start: 2, end: 2 + claim.length },
  ...(page === undefined ? {} : { page }),
})

// What `seedBillText` stores as a document's hash by default, so a pin matches the stored text (#603).
const HASH = 'hash-abc'

describe('GET /api/bills/:id: claimSources on a PDF', () => {
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
  const pin = (billId: string, docId: string, items: unknown[]) => db().update(bills)
    .set({ claimSources: JSON.stringify(items), claimSourcesDocId: docId, claimSourcesTextHash: HASH })
    .where(eq(bills.id, billId))
  const setting = (value: unknown) => db().insert(associationConfig)
    .values({ key: 'claim_links_enabled', value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: JSON.stringify(value) } })

  describe('a bill showing its own PDF analysis', () => {
    beforeEach(async () => {
      await seedBill({ id: 'a100', billNumber: 'A100', externalId: 'legiscan:100', tenantSummary: SUMMARY_A, matchType: 'keyword', aiProcessedAt: '2026-01-01 10:00:00' })
      await seedBillText('a100', { docId: '9101', type: 'Introduced', date: '2026-01-01', mime: 'application/pdf' })
      await pin('a100', '9101', [
        pdfItem('Requires a drop box in each county.', 'Each county shall have a drop box.', 7),
        pdfItem('Boxes are emptied by two employees.', 'Two employees shall empty each box.', null),
        pdfItem('Something the text never says.', '', 3, 'ungrounded'),
      ])
    })

    it('carries an unverified item\'s quote and page, and the PDF document it is pinned to', async () => {
      const d = await detail('a100')
      expect(d.claimSources?.billId).toBe('a100')
      expect(d.claimSources?.document).toMatchObject({ docId: '9101', mime: 'application/pdf' })
      expect(d.claimSources?.items[0]).toEqual({ claim: 'Requires a drop box in each county.', status: 'unverified', quote: 'Each county shall have a drop box.', page: 7 })
    })

    it('carries a null page for an item the model gave no usable page', async () => {
      expect(((await detail('a100')).claimSources?.items[1])).toEqual({ claim: 'Boxes are emptied by two employees.', status: 'unverified', quote: 'Two employees shall empty each box.', page: null })
    })

    it('carries a null page for an item stored with no page at all', async () => {
      await pin('a100', '9101', [pdfItem('Requires a drop box in each county.', 'Each county shall have a drop box.')])
      expect(((await detail('a100')).claimSources?.items[0])).toEqual({ claim: 'Requires a drop box in each county.', status: 'unverified', quote: 'Each county shall have a drop box.', page: null })
    })

    it('carries a stored page as it is, for the page to judge (zero, negative)', async () => {
      await pin('a100', '9101', [pdfItem('Requires a drop box in each county.', 'Q one.', 0), pdfItem('Boxes are emptied by two employees.', 'Q two.', -4)])
      expect((await detail('a100')).claimSources?.items.map(i => i.page)).toEqual([0, -4])
    })

    it('carries neither quote nor page for an ungrounded item', async () => {
      expect(((await detail('a100')).claimSources?.items[2])).toEqual({ claim: 'Something the text never says.', status: 'ungrounded' })
    })

    it('is null when the pinned PDF is no longer in the bill\'s text list', async () => {
      await env.DB.prepare('DELETE FROM bill_texts WHERE doc_id = ?').bind('9101').run()
      expect((await detail('a100')).claimSources).toBeNull()
    })

    it('is null with the instance setting off, and back once it is on again', async () => {
      await setting(false)
      expect((await detail('a100')).claimSources).toBeNull()
      await setting(true)
      expect((await detail('a100')).claimSources?.items[0].page).toBe(7)
    })
  })

  describe('an HTML bill\'s items', () => {
    it('never carry a quote or a page, even if one is stored on the item', async () => {
      await seedBill({ id: 'h1', billNumber: 'A101', externalId: 'legiscan:101', tenantSummary: SUMMARY_S, matchType: 'keyword', aiProcessedAt: '2026-01-01 10:00:00' })
      await seedBillText('h1', { docId: '9201', mime: 'text/html' })
      await pin('h1', '9201', [{
        claim: 'Requires a drop box in each county.', quote: 'Each county shall have a drop box.', page: 4, status: 'exact',
        claimAt: { start: 2, end: 36 }, quoteAt: { start: 10, end: 40 }, matched: 'Each county shall have a drop box.',
      }])
      expect((await detail('h1')).claimSources?.items).toEqual([
        { claim: 'Requires a drop box in each county.', status: 'exact', quoteAt: { start: 10, end: 40 }, matched: 'Each county shall have a drop box.' },
      ])
    })
  })

  describe('a companion group whose members\' files differ, analyzed at different times', () => {
    // S200 is tracked, so the group shows its analysis, though A100, a pulled
    // companion, was analyzed later. S200's file is a PDF; A100's is HTML.
    beforeEach(async () => {
      await seedBill({ id: 'a100', billNumber: 'A100', externalId: 'legiscan:100', tenantSummary: SUMMARY_A, matchType: null, aiProcessedAt: '2026-01-03 10:00:00' })
      await seedBill({ id: 's200', billNumber: 'S200', externalId: 'legiscan:200', tenantSummary: SUMMARY_S, matchType: 'keyword', aiProcessedAt: '2026-01-02 10:00:00' })
      await seedBillText('a100', { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html' })
      await seedBillText('s200', { docId: '9102', type: 'Amended', date: '2026-01-02', mime: 'application/pdf' })
      await pin('a100', '9001', [{ claim: 'Requires a drop box in each county.', quote: 'A100 own passage.', status: 'exact', claimAt: { start: 2, end: 36 }, quoteAt: { start: 5, end: 30 }, matched: 'A100 own passage.' }])
      await pin('s200', '9102', [pdfItem('Requires a drop box in each county.', 'S200 quote on a page.', 12)])
      await db().update(bills).set({ groupKey: 'a100' }).where(inArray(bills.id, ['a100', 's200']))
    })

    it('on A100\'s page carries S200\'s PDF items and document, which A100\'s texts lack', async () => {
      const d = await detail('a100')
      expect(d.analysisBillId).toBe('s200')
      expect(d.claimSources?.billId).toBe('s200')
      expect(d.claimSources?.document).toMatchObject({ docId: '9102', mime: 'application/pdf', type: 'Amended' })
      expect(d.claimSources?.items).toEqual([{ claim: 'Requires a drop box in each county.', status: 'unverified', quote: 'S200 quote on a page.', page: 12 }])
      expect(d.texts.map(t => t.docId)).toEqual(['9001'])
    })

    it('is null on A100\'s page when S200\'s pinned PDF is gone, though A100\'s own pin is fine', async () => {
      await env.DB.prepare('DELETE FROM bill_texts WHERE doc_id = ?').bind('9102').run()
      expect((await detail('a100')).claimSources).toBeNull()
    })

    it('follows the analysis back to A100\'s own HTML items once the group shows A100\'s', async () => {
      await db().update(bills).set({ matchType: 'keyword' }).where(eq(bills.id, 'a100'))
      const d = await detail('s200')
      expect(d.claimSources?.billId).toBe('a100')
      expect(d.claimSources?.items).toEqual([{ claim: 'Requires a drop box in each county.', status: 'exact', quoteAt: { start: 5, end: 30 }, matched: 'A100 own passage.' }])
    })
  })
})
