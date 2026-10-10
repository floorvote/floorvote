import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'

// Committees from LegiScan at the main seam (#299): getBill responses in, with
// the network stubbed, and central's bill API out. The committees come from
// what getBill already sends (`committee` and `referrals[]`), so the ingest
// spends no call beyond its one getBill.
vi.mock('../../src/providers/legiscan/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/legiscan/client')>('../../src/providers/legiscan/client')
  return { ...actual, getBill: vi.fn(), getBillText: vi.fn() }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { processIngestorQueue } from '../../src/queue/processor'
import * as legiscan from '../../src/providers/legiscan/client'
import { toHandle } from '../../src/lib/billHandle'
import { setupLsDb } from '../helpers/setupLsDb'

type Committee = { committee_id: number; chamber: string; chamber_id: number; name: string }

const ELECTIONS: Committee = { committee_id: 7001, chamber: 'A', chamber_id: 26, name: 'Elections' }
const JUDICIARY: Committee = { committee_id: 7002, chamber: 'S', chamber_id: 27, name: 'Judiciary' }

/** What getBill answers for one bill: only the fields this test reads vary. */
function getBillResponse(billId: number, number: string, committee: Committee | [], referrals: (Committee & { date: string })[]): any {
  return {
    bill_id: billId, change_hash: `hash-${billId}-${referrals.length}`, session_id: 2154,
    state: 'WI', state_id: 50, bill_number: number, bill_type: 'B', bill_type_id: '1',
    body: 'A', body_id: 26, current_body: 'A', current_body_id: 26,
    title: `Bill ${number}`, description: `Bill ${number}`, status: 2, status_date: '2026-01-16', completed: 0,
    pending_committee_id: Array.isArray(committee) ? 0 : committee.committee_id,
    url: `https://legiscan.com/WI/bill/${number}/2025`, state_link: '',
    session: { session_id: 2154, session_name: '2025-2026 Regular Session', year_start: 2025, year_end: 2026 },
    committee, referrals,
    progress: [], sponsors: [], history: [{ date: '2026-01-15', action: 'Introduced', chamber: 'A', chamber_id: 26, importance: 1 }],
    sasts: [], subjects: [], votes: [], texts: [], calendar: [], amendments: [], supplements: [],
  }
}

async function ingest(...responses: any[]) {
  const db = drizzle(env.DB, { schema })
  vi.mocked(legiscan.getBill).mockReset()
  for (const r of responses) vi.mocked(legiscan.getBill).mockResolvedValueOnce(r)
  const messages = responses.map(r => ({ body: { billId: r.bill_id }, ack: vi.fn(), retry: vi.fn() }))
  await processIngestorQueue({ messages } as any, { ...(env as any), LEGISCAN_API_KEY: 'test-key' }, db)
  for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
}

async function getBill(billId: number) {
  const { app } = await import('../../src/index-legiscan')
  const res = await app.fetch(new Request(`http://central/api/bills/${toHandle(billId)}`, {
    headers: { 'x-admin-secret': 'test-secret' },
  }), env as any)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

beforeEach(async () => {
  await setupLsDb()
  fetchMock.mockReset()
  fetchMock.mockRejectedValue(new Error('no network in this test'))
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.sessions).values({
    sessionId: 2154, state: 'WI', stateId: 50, yearStart: 2025, yearEnd: 2026,
    sessionName: '2025-2026 Regular Session', sessionTitle: '2025-2026 Regular Session', sessionTag: 'Regular Session',
    prefile: 0, sineDie: 0, prior: 0, special: 0,
  })
})

describe('committees from LegiScan', () => {
  it('serves a bill\'s pending committee and referrals, each pointing at its committee', async () => {
    await ingest(getBillResponse(9001, 'AB1', ELECTIONS, [
      { ...ELECTIONS, date: '2026-01-16' },
      { ...JUDICIARY, date: '2026-02-03' },
    ]))
    expect(legiscan.getBill).toHaveBeenCalledTimes(1)

    const bill = await getBill(9001)
    expect(bill.committee).toEqual({ committeeId: '7001', name: 'Elections', chamber: 'A' })
    expect(bill.referrals).toEqual([
      { date: '2026-01-16', committeeId: '7001', name: 'Elections', chamber: 'A' },
      { date: '2026-02-03', committeeId: '7002', name: 'Judiciary', chamber: 'S' },
    ])
  })

  it('names a committee the same on every bill, after the latest ingest that names it', async () => {
    await ingest(
      getBillResponse(9001, 'AB1', ELECTIONS, [{ ...ELECTIONS, date: '2026-01-16' }]),
      getBillResponse(9002, 'AB2', [], [{ ...ELECTIONS, date: '2026-01-20' }]),
    )
    expect((await getBill(9001)).referrals[0].committeeId).toBe((await getBill(9002)).referrals[0].committeeId)

    // LegiScan renames the committee. Only AB2 is ingested again, but AB1's
    // referral and pending committee read the new name too.
    const renamed = { ...ELECTIONS, name: 'Campaigns and Elections' }
    await ingest(getBillResponse(9002, 'AB2', [], [{ ...renamed, date: '2026-01-20' }]))
    const ab1 = await getBill(9001)
    expect(ab1.committee.name).toBe('Campaigns and Elections')
    expect(ab1.referrals.map((r: any) => r.name)).toEqual(['Campaigns and Elections'])
    expect((await getBill(9002)).referrals.map((r: any) => r.name)).toEqual(['Campaigns and Elections'])
  })

  it('keeps the name from the committee\'s latest session when an older session\'s bill is ingested again', async () => {
    const renamed = { ...ELECTIONS, name: 'Campaigns and Elections' }
    await ingest(getBillResponse(9001, 'AB1', renamed, [{ ...renamed, date: '2026-01-16' }]))
    const older = {
      ...getBillResponse(8001, 'AB7', [], [{ ...ELECTIONS, date: '2024-01-16' }]),
      session_id: 2100,
      session: { session_id: 2100, session_name: '2023-2024 Regular Session', year_start: 2023, year_end: 2024 },
    }
    await ingest(older)
    expect((await getBill(8001)).referrals.map((r: any) => [r.committeeId, r.name])).toEqual([['7001', 'Campaigns and Elections']])
    expect((await getBill(9001)).committee.name).toBe('Campaigns and Elections')
  })

  it('serves no committee for a bill LegiScan gives none, and keeps a referral that names no committee id', async () => {
    await ingest(getBillResponse(9003, 'AB3', [], [{ committee_id: 0, chamber: 'A', chamber_id: 26, name: 'Rules', date: '2026-01-18' }]))
    const bill = await getBill(9003)
    expect(bill.committee).toBeNull()
    expect(bill.referrals).toEqual([{ date: '2026-01-18', committeeId: null, name: 'Rules', chamber: 'A' }])
  })

  it('replaces a bill\'s referrals on every ingest, and records LegiScan as each committee\'s provider', async () => {
    await ingest(getBillResponse(9001, 'AB1', ELECTIONS, [{ ...ELECTIONS, date: '2026-01-16' }, { ...JUDICIARY, date: '2026-02-03' }]))
    await ingest(getBillResponse(9001, 'AB1', JUDICIARY, [{ ...JUDICIARY, date: '2026-02-03' }]))
    const bill = await getBill(9001)
    expect(bill.committee.committeeId).toBe('7002')
    expect(bill.referrals.map((r: any) => r.committeeId)).toEqual(['7002'])

    const rows = await drizzle(env.DB, { schema }).select().from(schema.committees).all()
    expect(rows.map(r => [r.committeeId, r.provider, r.state]).sort()).toEqual([[7001, 'legiscan', 'WI'], [7002, 'legiscan', 'WI']])
  })
})
