import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

// The bill detail carries the claim sources of the analysis the page shows
// (#571), so the page can link each claim to its passage. They are read through
// the shown analysis's bill (`readClaimSources`), which on a companion group's
// page can be another member: the links must open that member's document, never
// the page bill's own text. Invented bills A100 and S200; no real bill text.

type Detail = {
  id: string
  tenantSummary: string | null
  analysisBillId: string
  claimLinksEnabled: boolean
  claimSources: null | {
    billId: string
    document: { docId: string; type: string; date: string; mime: string; stateLink: string | null; altStateLink: string | null }
    items: { claim: string; status: string; quoteAt?: { start: number; end: number }; matched?: string }[]
  }
  texts: { docId: string }[]
}

const SUMMARY_A = '- Requires a drop box in each county.'
const SUMMARY_S = '- Requires a drop box in each county.\n- Boxes are emptied by two employees.'

const item = (claim: string, status: string, at?: [number, number], matched?: string) => ({
  claim, quote: matched ?? 'x', status, claimAt: { start: 2, end: 2 + claim.length },
  ...(at ? { quoteAt: { start: at[0], end: at[1] }, matched } : {}),
})

// What `seedBillText` stores as a document's hash by default, so a pin matches the stored text (#603).
const HASH = 'hash-abc'

describe('GET /api/bills/:id: claimSources', () => {
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

  describe('a bill showing its own analysis', () => {
    beforeEach(async () => {
      await seedBill({ id: 'a100', billNumber: 'A100', externalId: 'legiscan:100', tenantSummary: SUMMARY_A, matchType: 'keyword', aiProcessedAt: '2026-01-01 10:00:00' })
      await seedBillText('a100', { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html' })
      await pin('a100', '9001', [
        item('Requires a drop box in each county.', 'exact', [10, 40], 'Each county shall have a drop box.'),
        item('Something the text never says.', 'ungrounded'),
      ])
    })

    it('carries the stored items, the analyzed bill, and the pinned document', async () => {
      const d = await detail('a100')
      expect(d.claimSources).toBeTruthy()
      expect(d.claimSources?.billId).toBe('a100')
      expect(d.claimSources?.document).toEqual({ docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: null, altStateLink: null })
      expect(d.claimSources?.items).toEqual([
        { claim: 'Requires a drop box in each county.', status: 'exact', quoteAt: { start: 10, end: 40 }, matched: 'Each county shall have a drop box.' },
        { claim: 'Something the text never says.', status: 'ungrounded' },
      ])
    })

    it('is null when the pinned document is no longer in the bill\'s text list', async () => {
      await env.DB.prepare('DELETE FROM bill_texts WHERE doc_id = ?').bind('9001').run()
      expect((await detail('a100')).claimSources).toBeNull()
    })

    it('is null with the instance setting off, and back once it is on again', async () => {
      await setting(false)
      expect((await detail('a100')).claimSources).toBeNull()
      await setting(true)
      expect((await detail('a100')).claimSources?.items).toHaveLength(2)
    })

    it('is null for a bill with no stored claim sources', async () => {
      await seedBill({ id: 'plain', billNumber: 'HB 9', externalId: 'legiscan:9', tenantSummary: 'A summary.' })
      await seedBillText('plain', { docId: '9009' })
      expect((await detail('plain')).claimSources).toBeNull()
    })

    it('leaves out an item from before resolution, which has no status', async () => {
      await pin('a100', '9001', [{ claim: 'Requires a drop box in each county.', quote: 'Each county' }])
      expect((await detail('a100')).claimSources?.items).toEqual([])
    })
  })

  describe('a companion group whose members\' texts differ, analyzed at different times', () => {
    // S200 is tracked, so the group shows its analysis (#559), though A100, a
    // pulled companion, was analyzed later. Each is pinned to its own document,
    // and A100's text list doesn't have S200's.
    beforeEach(async () => {
      await seedBill({ id: 'a100', billNumber: 'A100', externalId: 'legiscan:100', tenantSummary: SUMMARY_A, matchType: null, aiProcessedAt: '2026-01-03 10:00:00' })
      await seedBill({ id: 's200', billNumber: 'S200', externalId: 'legiscan:200', tenantSummary: SUMMARY_S, matchType: 'keyword', aiProcessedAt: '2026-01-02 10:00:00' })
      await seedBillText('a100', { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html' })
      await seedBillText('s200', { docId: '9002', type: 'Amended', date: '2026-01-02', mime: 'text/html' })
      await pin('a100', '9001', [item('Requires a drop box in each county.', 'exact', [5, 30], 'A100 own passage.')])
      await pin('s200', '9002', [
        item('Requires a drop box in each county.', 'exact', [50, 80], 'S200 passage one.'),
        item('Boxes are emptied by two employees.', 'fuzzy', [120, 150], 'S200 passage two.'),
      ])
      await db().update(bills).set({ groupKey: 'a100' }).where(inArray(bills.id, ['a100', 's200']))
    })

    it('on A100\'s page carries S200\'s claim sources, pinned to S200\'s document, which A100\'s texts lack', async () => {
      const d = await detail('a100')
      expect(d.tenantSummary).toBe(SUMMARY_S)
      expect(d.analysisBillId).toBe('s200')
      expect(d.claimSources?.billId).toBe('s200')
      expect(d.claimSources?.document.docId).toBe('9002')
      expect(d.claimSources?.document.type).toBe('Amended')
      expect(d.claimSources?.items.map(i => i.matched)).toEqual(['S200 passage one.', 'S200 passage two.'])
      expect(d.texts.map(t => t.docId)).toEqual(['9001'])
    })

    it('on S200\'s own page carries the same', async () => {
      const d = await detail('s200')
      expect(d.claimSources?.billId).toBe('s200')
      expect(d.claimSources?.document.docId).toBe('9002')
    })

    it('is null on A100\'s page when S200\'s pinned document is gone, though A100\'s own pin is fine', async () => {
      await env.DB.prepare('DELETE FROM bill_texts WHERE doc_id = ?').bind('9002').run()
      expect((await detail('a100')).claimSources).toBeNull()
    })

    it('follows the analysis to A100\'s own once the group shows A100\'s', async () => {
      await db().update(bills).set({ matchType: 'keyword' }).where(eq(bills.id, 'a100'))
      const d = await detail('s200')
      expect(d.analysisBillId).toBe('a100')
      expect(d.claimSources?.billId).toBe('a100')
      expect(d.claimSources?.document.docId).toBe('9001')
      expect(d.claimSources?.items.map(i => i.matched)).toEqual(['A100 own passage.'])
    })
  })

  // A document whose content changes under the same id keeps its doc id and gets
  // a new hash (#603). The pin holds the hash the model read, so a stored hash
  // that differs means the offsets are into a text that is gone.
  describe('a document whose text changed under the same id', () => {
    const setStoredHash = (docId: string, textHash: string) =>
      env.DB.prepare('UPDATE bill_texts SET text_hash = ? WHERE doc_id = ?').bind(textHash, docId).run()

    beforeEach(async () => {
      await seedBill({ id: 'a100', billNumber: 'A100', externalId: 'legiscan:100', tenantSummary: SUMMARY_A, matchType: 'keyword', aiProcessedAt: '2026-01-01 10:00:00' })
      await seedBillText('a100', { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html', textHash: 'hash-v1' })
      await db().update(bills).set({
        claimSources: JSON.stringify([item('Requires a drop box in each county.', 'exact', [10, 40], 'Each county shall have a drop box.')]),
        claimSourcesDocId: '9001',
        claimSourcesTextHash: 'hash-v1',
      }).where(eq(bills.id, 'a100'))
    })

    it('still links when the stored hash is the pinned one', async () => {
      expect((await detail('a100')).claimSources?.items).toHaveLength(1)
    })

    it('renders as plain text, with no claim sources, once the stored hash differs', async () => {
      await setStoredHash('9001', 'hash-v2')
      const d = await detail('a100')
      expect(d.claimSources).toBeNull()
      expect(d.tenantSummary).toBe(SUMMARY_A)
    })

    it('keeps the stored items, so a matching hash brings the links back', async () => {
      await setStoredHash('9001', 'hash-v2')
      expect((await detail('a100')).claimSources).toBeNull()
      await setStoredHash('9001', 'hash-v1')
      expect((await detail('a100')).claimSources?.items).toHaveLength(1)
    })

    it('links again once a re-analysis pins the new hash', async () => {
      await setStoredHash('9001', 'hash-v2')
      await db().update(bills).set({ claimSourcesTextHash: 'hash-v2' }).where(eq(bills.id, 'a100'))
      expect((await detail('a100')).claimSources?.items).toHaveLength(1)
    })

    it('resolves on the doc id alone when the stored hash is empty, as rows from before this change are', async () => {
      await setStoredHash('9001', '')
      expect((await detail('a100')).claimSources?.items).toHaveLength(1)
    })

    it.each([['null', null], ['empty', '']])('resolves on the doc id alone when the pinned hash is %s', async (_label, pinned) => {
      await setStoredHash('9001', 'hash-v2')
      await db().update(bills).set({ claimSourcesTextHash: pinned }).where(eq(bills.id, 'a100'))
      expect((await detail('a100')).claimSources?.items).toHaveLength(1)
    })

    it('judges a companion group\'s shown analysis against that member\'s document, not the page bill\'s', async () => {
      await seedBill({ id: 'b300', billNumber: 'B300', externalId: 'legiscan:300', tenantSummary: SUMMARY_A, matchType: null, aiProcessedAt: '2026-01-01 09:00:00' })
      await seedBillText('b300', { docId: '9003', date: '2026-01-01', textHash: 'hash-other' })
      await db().update(bills).set({ groupKey: 'a100' }).where(inArray(bills.id, ['a100', 'b300']))
      await setStoredHash('9001', 'hash-v2')
      expect((await detail('b300')).claimSources).toBeNull()
      await setStoredHash('9001', 'hash-v1')
      expect((await detail('b300')).claimSources?.billId).toBe('a100')
    })
  })
})
