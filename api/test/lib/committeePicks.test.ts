import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { billCommittees } from '../../src/db/schema'
import { committeeSizes, summarizeCommitteePicks } from '../../src/lib/committeePicks'

// The Bill committees card (#471) sizes each committee against the session and keeps a running total of the bills
// that would be fully analyzed: the keyword matches, the bills added by hand, and the bills referred to a picked
// committee.

async function refer(billId: string, committeeId: string, name: string, state = 'RI') {
  await getDb(env.DB).insert(billCommittees).values({ billId, committeeId, state, name, chamber: 'S', isCurrent: false })
}

let ids: Record<string, string>

beforeEach(async () => {
  await clearDb()
  ids = {
    keyword: await seedBill({ externalId: 'legiscan:1', title: 'Election Audits', matchType: 'keyword' }),
    manual: await seedBill({ externalId: 'legiscan:2', title: 'Parks', matchType: 'manual' }),
    judiciary: await seedBill({ externalId: 'legiscan:3', title: 'Court Fees', matchType: null }),
    both: await seedBill({ externalId: 'legiscan:4', title: 'Court Calendars', matchType: null }),
    none: await seedBill({ externalId: 'legiscan:5', title: 'Fishing Licenses', matchType: null }),
    stale: await seedBill({ externalId: 'legiscan:6', title: 'Bridge Naming', matchType: 'keyword' }),
    nj: await seedBill({ externalId: 'legiscan:7', title: 'Tolls', state: 'NJ', matchType: null }),
    draft: await seedBill({ title: 'Draft', isDraft: true, matchType: null }),
  }
  await refer(ids.keyword, '101', 'Judiciary')
  await refer(ids.judiciary, '101', 'Judiciary')
  await refer(ids.both, '101', 'Judiciary')
  await refer(ids.both, '102', 'Rules')
  await refer(ids.nj, '201', 'Transportation', 'NJ')
})

describe('committeeSizes', () => {
  it("counts each committee's bills, names it, and counts its state's bills", async () => {
    const sizes = await committeeSizes(getDb(env.DB))
    expect(sizes.counts).toEqual({ 101: 3, 102: 1, 201: 1 })
    expect(sizes.info['102']).toEqual({ name: 'Rules', state: 'RI', chamber: 'S' })
    expect(sizes.stateTotals).toEqual({ RI: 6, NJ: 1 })
  })
})

describe('summarizeCommitteePicks', () => {
  it('counts the keyword matches, the bills added by hand, and the bills in a picked committee, once each', async () => {
    const summary = await summarizeCommitteePicks(getDb(env.DB), ['101'], ['election'])
    // keyword, manual, judiciary, both. `stale` no longer matches the keywords.
    expect(summary).toEqual({ total: 7, analyzed: 4, added: 2 })
  })

  it('counts only the keyword matches and the bills added by hand with no committee picked', async () => {
    expect(await summarizeCommitteePicks(getDb(env.DB), [], ['election'])).toEqual({ total: 7, analyzed: 2, added: 0 })
  })
})
