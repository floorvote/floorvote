import { describe, it, expect, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig, bills } from '../../src/db/schema'

// A companion group's summary is its lead bill's (see **Lead bill** in
// CONTEXT.md). One rule picks the lead for the list row, the list's bill-number
// sort, the summary and tags the group shows on every page, and the tag filter:
// furthest along, then the newest bill text, then the bill number, then the id.
// Only while the lead has no analysis does the group show another member's.
// Invented bills HB10 and SB20 in one state.

type Member = { id: string; billNumber: string }
type Row = { id: string; billNumber: string; tenantSummary: string | null; tags: string[]; group?: Member[] }
type ListBody = { bills: Row[]; pagination: { total: number } }
type Page = { tenantSummary: string | null; tags: string[]; analysisBillId: string; analysisBillNumber: string; analysisLastAiTextDocId: string | null }

describe("a companion group's summary is its lead bill's", () => {
  let cookie: string
  const db = () => getDb(env.DB)

  async function list(qs = ''): Promise<ListBody> {
    const res = await SELF.fetch(`https://x/api/bills?${qs}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as ListBody
  }
  async function page(id: string): Promise<Page> {
    const res = await SELF.fetch(`https://x/api/bills/${id}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    return await res.json() as Page
  }
  const numbers = (body: ListBody) => body.bills.map(b => b.group ? b.group.map(g => g.billNumber).join('+') : b.billNumber)
  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: [...ids].sort()[0] }).where(inArray(bills.id, ids))
  }
  async function analyzed(id: string, at: string, tags: string[], docId: string | null = null) {
    await db().update(bills).set({ tenantSummary: `${id} summary`, tags: JSON.stringify(tags), aiProcessedAt: at, lastAiTextDocId: docId }).where(eq(bills.id, id))
  }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    cookie = `session=${await seedSession(await seedUser({ role: 'admin', email: 'admin@example.com' }))}`
    await db().insert(associationConfig).values({ key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Energy' }, { name: 'Labor' }]) })
  })

  /**
   * HB10 and SB20, both tracked and equally far along. SB20 has the newer text,
   * so it leads, though HB10's number comes first. HB10 was analyzed later.
   */
  async function newerTextLeads() {
    await seedBill({ id: 'h10', billNumber: 'HB10', state: 'TX', status: 'Engrossed', statusRank: 200, matchType: 'keyword' })
    await seedBill({ id: 's20', billNumber: 'SB20', state: 'TX', status: 'Engrossed', statusRank: 200, matchType: 'keyword' })
    await group('h10', 's20')
    await seedBillText('h10', { docId: '501', date: '2026-03-01' })
    await seedBillText('s20', { docId: '601', date: '2026-02-01' })
    await seedBillText('s20', { docId: '602', date: '2026-06-01' })
    await analyzed('s20', '2026-07-01 00:00:00', ['Energy'], '602')
    await analyzed('h10', '2026-09-01 00:00:00', ['Labor'], '501')
  }

  describe('the lead', () => {
    it('is the bill with the newer text when both are equally far along, on the list row', async () => {
      await newerTextLeads()
      const [row] = (await list()).bills
      expect(row.id).toBe('s20')
      expect(row.group?.map(g => g.billNumber)).toEqual(['SB20', 'HB10'])
    })

    it('is the bill furthest along, even when the other has the newer text', async () => {
      await newerTextLeads()
      await db().update(bills).set({ statusRank: 300 }).where(eq(bills.id, 's20'))
      await seedBillText('h10', { docId: '503', date: '2026-08-01' })
      const [row] = (await list()).bills
      expect(row.id).toBe('s20')
      expect(row.tenantSummary).toBe('s20 summary')
    })

    it('is the lower bill number when status and newest text tie', async () => {
      await newerTextLeads()
      await seedBillText('h10', { docId: '502', date: '2026-06-01' })
      await analyzed('s20', '2026-09-15 00:00:00', ['Energy'], '602')
      const [row] = (await list()).bills
      expect(row.id).toBe('h10')
      expect(row.tenantSummary).toBe('h10 summary')
    })

    it("sorts the group by bill number at its lead's number", async () => {
      await newerTextLeads()
      await seedBill({ id: 'x', billNumber: 'HB50', state: 'TX', status: 'Introduced', statusRank: 100 })
      await seedBill({ id: 'y', billNumber: 'SB30', state: 'TX', status: 'Introduced', statusRank: 100 })
      expect(numbers(await list('sort=bill&dir=asc'))).toEqual(['HB50', 'SB20+HB10', 'SB30'])
    })
  })

  describe('the summary and tags', () => {
    it("are the lead's on the list row, though another member was analyzed later", async () => {
      await newerTextLeads()
      const [row] = (await list()).bills
      expect(row).toMatchObject({ id: 's20', tenantSummary: 's20 summary', tags: ['Energy'] })
    })

    it("are the lead's on every member's page, which names the lead as the source", async () => {
      await newerTextLeads()
      for (const id of ['h10', 's20']) {
        expect(await page(id)).toMatchObject({
          tenantSummary: 's20 summary', tags: ['Energy'], analysisBillId: 's20', analysisBillNumber: 'SB20', analysisLastAiTextDocId: '602',
        })
      }
    })

    it('agree between the list row and the page: the row is about the bill the summary comes from', async () => {
      await newerTextLeads()
      // Equally far along with the same newest text: HB10 leads by its number, though SB20 was analyzed later.
      await seedBillText('h10', { docId: '502', date: '2026-06-01' })
      await analyzed('s20', '2026-09-15 00:00:00', ['Energy'], '602')
      const [row] = (await list()).bills
      expect((await page('h10')).analysisBillId).toBe(row.id)
    })

    it("filter and count by the lead's tags", async () => {
      await newerTextLeads()
      expect((await list('tag=Energy')).pagination.total).toBe(1)
      expect((await list('tag=Labor')).pagination.total).toBe(0)
    })

    it('stay the lead\'s when another member is analyzed again', async () => {
      await newerTextLeads()
      await analyzed('h10', '2026-10-01 00:00:00', ['Labor'], '501')
      expect((await page('s20')).tenantSummary).toBe('s20 summary')
      expect((await list('tag=Labor')).pagination.total).toBe(0)
    })

    it('move to the new lead when another member gets a newer text', async () => {
      await newerTextLeads()
      await analyzed('s20', '2026-09-15 00:00:00', ['Energy'], '602')
      expect((await page('h10')).analysisBillId).toBe('s20')
      await seedBillText('h10', { docId: '503', date: '2026-08-01' })
      expect(await page('s20')).toMatchObject({ tenantSummary: 'h10 summary', analysisBillId: 'h10' })
      expect((await list('tag=Labor')).pagination.total).toBe(1)
      expect((await list('tag=Energy')).pagination.total).toBe(0)
    })

    it('are an untracked lead\'s too: the lead is picked among every member, tracked or not', async () => {
      await newerTextLeads()
      await db().update(bills).set({ matchType: null }).where(eq(bills.id, 's20'))
      expect(await page('h10')).toMatchObject({ tenantSummary: 's20 summary', analysisBillId: 's20' })
      expect((await list('tag=Energy')).pagination.total).toBe(1)
    })
  })

  describe('while the lead has no analysis', () => {
    beforeEach(async () => {
      await newerTextLeads()
      await db().update(bills).set({ tenantSummary: null, tags: '[]', aiProcessedAt: null, lastAiTextDocId: null }).where(eq(bills.id, 's20'))
    })

    it("shows another member's analysis, and names that member as the source", async () => {
      expect(await page('s20')).toMatchObject({ tenantSummary: 'h10 summary', tags: ['Labor'], analysisBillId: 'h10', analysisLastAiTextDocId: '501' })
      const [row] = (await list()).bills
      expect(row).toMatchObject({ id: 's20', tenantSummary: 'h10 summary', tags: ['Labor'] })
      expect((await list('tag=Labor')).pagination.total).toBe(1)
    })

    it("shows the lead's once it arrives, though it is older than the other member's", async () => {
      await analyzed('s20', '2026-08-01 00:00:00', ['Energy'], '602')
      expect(await page('h10')).toMatchObject({ tenantSummary: 's20 summary', analysisBillId: 's20' })
      expect((await list('tag=Energy')).pagination.total).toBe(1)
      expect((await list('tag=Labor')).pagination.total).toBe(0)
    })
  })
})
