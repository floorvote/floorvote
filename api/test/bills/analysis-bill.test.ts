import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

// A bill's page shows the analysis of one bill (#554): its own, or the one a
// tracked member of its companion group has. Regenerate re-analyzes that bill
// and polls it (#563), so the detail says which bill it is and when and how it
// was last analyzed.

type Detail = {
  id: string
  aiProcessedAt: string | null
  aiSkipReason: string | null
  tenantSummary: string | null
  analysisBillId: string
  analysisBillExternalId: string | null
  analysisBillNumber: string
  analysisAiProcessedAt: string | null
  analysisAiSkipReason: string | null
  analysisTextStatus: string | null
}

describe('GET /api/bills/:id: the bill the shown analysis comes from', () => {
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

  /** Puts the bills in one companion group, keyed by the first. */
  async function group(...ids: string[]) {
    await db().update(bills).set({ groupKey: ids[0] }).where(inArray(bills.id, ids))
  }

  it('is a bill in no group\'s own bill, with its own analysis time and skip reason', async () => {
    await seedBill({ id: 'solo', billNumber: 'HB 1', externalId: 'legiscan:1', tenantSummary: 'Solo summary.', aiProcessedAt: '2026-09-01 00:00:00', textStatus: 'in_r2' })
    await db().update(bills).set({ aiSkipReason: 'pdf_too_large' }).where(eq(bills.id, 'solo'))
    const d = await detail('solo')
    expect(d).toMatchObject({
      analysisBillId: 'solo',
      analysisBillExternalId: 'legiscan:1',
      analysisBillNumber: 'HB 1',
      analysisAiProcessedAt: '2026-09-01 00:00:00',
      analysisAiSkipReason: 'pdf_too_large',
      analysisTextStatus: 'in_r2',
    })
  })

  it('is a never-analyzed bill in no group\'s own bill, with no analysis time', async () => {
    await seedBill({ id: 'stub', billNumber: 'HB 2', externalId: 'legiscan:2', matchType: null })
    const d = await detail('stub')
    expect(d).toMatchObject({ analysisBillId: 'stub', analysisBillExternalId: 'legiscan:2', analysisAiProcessedAt: null, analysisAiSkipReason: null })
  })

  it('is the tracked bill on a pulled companion\'s page, whose own newer analysis is not shown', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:190', matchType: 'keyword', tenantSummary: 'Tracked summary.', aiProcessedAt: '2026-09-01 00:00:00', textStatus: 'in_r2' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', externalId: 'legiscan:1713', matchType: null, tenantSummary: 'Companion summary.', aiProcessedAt: '2026-09-05 00:00:00', textStatus: 'available' })
    await group('a190', 'b1713')
    const d = await detail('b1713')
    expect(d.tenantSummary).toBe('Tracked summary.')
    expect(d).toMatchObject({
      id: 'b1713',
      // The page's own analysis time is the companion's, and is not what the page shows.
      aiProcessedAt: '2026-09-05 00:00:00',
      analysisBillId: 'a190',
      analysisBillExternalId: 'legiscan:190',
      analysisBillNumber: 'A190',
      analysisAiProcessedAt: '2026-09-01 00:00:00',
      analysisAiSkipReason: null,
      analysisTextStatus: 'in_r2',
    })
  })

  it('carries the tracked bill\'s skip reason, not the page\'s', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:190', matchType: 'keyword', tenantSummary: 'Tracked summary.', aiProcessedAt: '2026-09-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', externalId: 'legiscan:1713', matchType: null, tenantSummary: 'Companion summary.', aiProcessedAt: '2026-09-05 00:00:00' })
    await db().update(bills).set({ aiSkipReason: 'pdf_too_large' }).where(eq(bills.id, 'a190'))
    await group('a190', 'b1713')
    const d = await detail('b1713')
    expect(d.aiSkipReason).toBeNull()
    expect(d.analysisAiSkipReason).toBe('pdf_too_large')
  })

  it('is the tracked bill itself on its own page', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:190', matchType: 'keyword', tenantSummary: 'Tracked summary.', aiProcessedAt: '2026-09-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', externalId: 'legiscan:1713', matchType: null, tenantSummary: 'Companion summary.', aiProcessedAt: '2026-09-05 00:00:00' })
    await group('a190', 'b1713')
    expect(await detail('a190')).toMatchObject({ analysisBillId: 'a190', analysisBillNumber: 'A190', analysisAiProcessedAt: '2026-09-01 00:00:00' })
  })

  it('is the most recently analyzed of any member when no tracked member has an analysis, on every member\'s page', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:190', matchType: 'keyword' }) // tracked, never analyzed
    await seedBill({ id: 'b1713', billNumber: 'S1713', externalId: 'legiscan:1713', matchType: null, tenantSummary: 'Older.', aiProcessedAt: '2026-09-01 00:00:00' })
    await seedBill({ id: 'c1714', billNumber: 'S1714', externalId: 'legiscan:1714', matchType: null, tenantSummary: 'Newer.', aiProcessedAt: '2026-09-05 00:00:00' })
    await group('a190', 'b1713', 'c1714')
    for (const id of ['a190', 'b1713', 'c1714']) {
      expect(await detail(id)).toMatchObject({ analysisBillId: 'c1714', analysisBillExternalId: 'legiscan:1714', analysisAiProcessedAt: '2026-09-05 00:00:00' })
    }
  })

  it('is the bill\'s own when its group has no analysis at all', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:190', matchType: 'keyword' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', externalId: 'legiscan:1713', matchType: null })
    await group('a190', 'b1713')
    expect(await detail('b1713')).toMatchObject({ analysisBillId: 'b1713', analysisAiProcessedAt: null })
    expect(await detail('a190')).toMatchObject({ analysisBillId: 'a190', analysisAiProcessedAt: null })
  })

  it('gives each bill its own after the group is split', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:190', matchType: 'keyword', tenantSummary: 'Tracked summary.', aiProcessedAt: '2026-09-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', externalId: 'legiscan:1713', matchType: null, tenantSummary: 'Companion summary.', aiProcessedAt: '2026-09-05 00:00:00' })
    await group('a190', 'b1713')
    expect((await detail('b1713')).analysisBillId).toBe('a190')
    await db().update(bills).set({ groupKey: null }).where(inArray(bills.id, ['a190', 'b1713']))
    expect(await detail('b1713')).toMatchObject({ analysisBillId: 'b1713', analysisBillNumber: 'S1713', analysisAiProcessedAt: '2026-09-05 00:00:00' })
    expect(await detail('a190')).toMatchObject({ analysisBillId: 'a190' })
  })

  it('moves to the companion once it matches on its own', async () => {
    await seedBill({ id: 'a190', billNumber: 'A190', externalId: 'legiscan:190', matchType: 'keyword', tenantSummary: 'Tracked summary.', aiProcessedAt: '2026-09-01 00:00:00' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', externalId: 'legiscan:1713', matchType: null, tenantSummary: 'Companion summary.', aiProcessedAt: '2026-09-05 00:00:00' })
    await group('a190', 'b1713')
    await db().update(bills).set({ matchType: 'keyword' }).where(eq(bills.id, 'b1713'))
    expect(await detail('a190')).toMatchObject({ analysisBillId: 'b1713', analysisBillExternalId: 'legiscan:1713' })
  })
})
