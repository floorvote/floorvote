import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { bills } from '../../src/db/schema'
import type { TenantQueueMessage } from '../../src/types'

// Every delivery stores the bill's committees (#471): the committee central names it pending in, and each committee
// it was referred to, so the bill list can filter by committee without asking central. A bill's rows are replaced on
// each write, so a committee the bill left is gone.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 'S', tags: [], relevanceScore: 7 }) }
})

const BILL_ID = 'bill:4710'

const centralBill = {
  billId: BILL_ID,
  sessionId: 'ri:2026',
  sessionName: '2026 Regular Session',
  state: 'RI',
  number: 'S2655',
  title: 'Energy Facility Act',
  abstract: null,
  status: 'Introduced',
  statusDate: '2026-05-01',
  updatedAt: '2026-05-21T00:00:00Z',
  stateUrl: null,
  textHash: 'h1',
  textR2Key: null,
  texts: [{ docId: 'd1', note: 'Introduced', date: '2026-05-01', links: [{ url: 'https://x/1', mediaType: 'text/html' }] }],
  actions: [{ description: 'Referred to Senate Judiciary', date: '2026-05-02', chamber: 'upper', classification: [], order: 1 }],
  sponsors: [],
  votes: [],
  relatedBills: [],
  committee: { committeeId: '1021', name: 'Judiciary', chamber: 'S' },
  referrals: [
    { date: '2026-05-01', committeeId: '1030', name: 'Rules', chamber: 'S' },
    { date: '2026-05-02', committeeId: '1021', name: 'Judiciary', chamber: 'S' },
    // DC's "Retained by the Council" and the like name no committee, so they have no row.
    { date: '2026-05-03', committeeId: null, name: 'Retained by the Council', chamber: null },
  ],
}

const testEnv = { ...env, TENANT_ID: 'test-tenant', CENTRAL_API_URL: 'https://central.test' }

function serve(bill: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/text')) return Promise.resolve({ ok: true, json: async () => ({ type: 'html', content: '<p>t</p>' }) })
    return Promise.resolve({ ok: true, json: async () => bill })
  }))
}

async function committeesOf(externalId: string) {
  const { results } = await env.DB.prepare(
    `SELECT bc.committee_id AS id, bc.state, bc.name, bc.chamber, bc.is_current AS current
     FROM bill_committees bc JOIN bills b ON b.id = bc.bill_id WHERE b.external_id = ? ORDER BY bc.committee_id`,
  ).bind(externalId).all<{ id: string; state: string; name: string; chamber: string | null; current: number }>()
  return results
}

const JUDICIARY = { id: '1021', state: 'RI', name: 'Judiciary', chamber: 'S', current: 1 }
const RULES = { id: '1030', state: 'RI', name: 'Rules', chamber: 'S', current: 0 }

describe('a delivery stores the bill\'s committees', () => {
  beforeEach(async () => {
    await clearDb()
    vi.clearAllMocks()
  })

  it('on a stub, with the pending committee marked current', async () => {
    serve(centralBill)
    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, stubOnly: true }
    await processCentralNotification(msg, testEnv as never, getDb(env.DB))
    expect(await committeesOf(BILL_ID)).toEqual([JUDICIARY, RULES])
  })

  it('on a stub delivery to a bill already analyzed', async () => {
    const db = getDb(env.DB)
    await db.insert(bills).values({ id: 'b1', externalId: BILL_ID, billNumber: 'S2655', title: 'T', state: 'RI', status: 'Introduced', session: '2026', aiProcessedAt: '2026-05-20 00:00:00' })
    serve(centralBill)
    await processCentralNotification({ tenantId: 'test-tenant', billId: BILL_ID, stubOnly: true }, testEnv as never, db)
    expect(await committeesOf(BILL_ID)).toEqual([JUDICIARY, RULES])
  })

  it('on a metadata refresh', async () => {
    serve(centralBill)
    await processCentralNotification({ tenantId: 'test-tenant', billId: BILL_ID, metadataOnly: true }, testEnv as never, getDb(env.DB))
    expect(await committeesOf(BILL_ID)).toEqual([JUDICIARY, RULES])
  })

  it('on a full delivery', async () => {
    serve(centralBill)
    await processCentralNotification({ tenantId: 'test-tenant', billId: BILL_ID, matchType: 'keyword', forceMetadata: true }, testEnv as never, getDb(env.DB))
    expect(await committeesOf(BILL_ID)).toEqual([JUDICIARY, RULES])
  })

  it('replaces them on the next delivery, so a bill reported out of committee has none current', async () => {
    serve(centralBill)
    const msg: TenantQueueMessage = { tenantId: 'test-tenant', billId: BILL_ID, stubOnly: true }
    await processCentralNotification(msg, testEnv as never, getDb(env.DB))
    serve({ ...centralBill, committee: null, referrals: [centralBill.referrals[1]] })
    await processCentralNotification(msg, testEnv as never, getDb(env.DB))
    expect(await committeesOf(BILL_ID)).toEqual([{ ...JUDICIARY, current: 0 }])
  })

  it('stores a pending committee no referral names', async () => {
    serve({ ...centralBill, referrals: [] })
    await processCentralNotification({ tenantId: 'test-tenant', billId: BILL_ID, stubOnly: true }, testEnv as never, getDb(env.DB))
    expect(await committeesOf(BILL_ID)).toEqual([JUDICIARY])
  })
})
