import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { clearDb } from '../helpers/migrations'

beforeEach(async () => {
  await clearDb()
})

type PersonSeed = { peopleId: number; name: string; party?: string | null; provider?: string }

/** One bill and one roll call whose voters are the given people (plus a vote row per extra people id with no people row). */
async function seedBill(people: PersonSeed[], opts: { provider?: string; state?: string; orphanIds?: number[] } = {}) {
  const db = drizzle(env.DB, { schema })
  const provider = opts.provider ?? 'legiscan'
  const state = opts.state ?? 'RI'
  await db.insert(schema.sessions).values({ sessionId: 1, state, stateId: 39, yearStart: 2026, yearEnd: 2026, sessionName: `${state} 2026`, sessionTitle: 'Regular' })
  await db.insert(schema.bills).values({ billId: 101, sessionId: 1, state, stateId: 0, billNumber: 'H101', title: 'Bill 101', changeHash: 'h', status: 1, provider })
  for (const p of people) {
    await db.insert(schema.people).values({ peopleId: p.peopleId, name: p.name, stateId: 0, provider: p.provider ?? provider, party: p.party ?? null } as any)
  }
  const orphans = opts.orphanIds ?? []
  const all = [...people.map(p => p.peopleId), ...orphans]
  await db.insert(schema.rollCalls).values({ rollCallId: 31, billId: 101, date: '2026-01-05', description: 'Passage', yea: all.length, nay: 0, nv: 0, absent: 0, total: all.length, passed: 1, chamber: 'H' })
  await db.insert(schema.rollCallVotes).values(all.map(id => ({ id: `v${id}`, rollCallId: 31, peopleId: id, voteId: 1, voteText: 'Yea' })))
}

async function voters() {
  const res = await app.request('/api/bills/legiscan:101', { headers: { 'x-admin-secret': 'test-secret' } }, env)
  expect(res.status).toBe(200)
  const body = await res.json() as any
  const list = body.votes[0].legislatorVotes as { personId: string; name: string; party?: string | null }[]
  return { list, party: (name: string) => list.find(v => v.name === name)!.party }
}

describe('roll call voters carry their party', () => {
  it("reads each LegiScan voter's party from their people row", async () => {
    await seedBill([
      { peopleId: 1, name: 'Ana Diaz', party: 'D' },
      { peopleId: 2, name: 'Ben Cole', party: 'R' },
      { peopleId: 3, name: 'Cy Park', party: 'I' },
    ])
    const { party } = await voters()
    expect(party('Ana Diaz')).toBe('D')
    expect(party('Ben Cole')).toBe('R')
    expect(party('Cy Park')).toBe('I')
  })

  it('sends a party on every voter, null where the people row has none', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', party: 'D' }, { peopleId: 2, name: 'Ben Cole', party: null }])
    const { list } = await voters()
    expect(list.map(v => [v.name, v.party])).toEqual([['Ana Diaz', 'D'], ['Ben Cole', null]])
  })

  it('sends null for a voter with no people row, and still lists them', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', party: 'D' }], { orphanIds: [999] })
    const { list } = await voters()
    expect(list).toContainEqual({ personId: '999', name: '999', vote: 'Yea', url: null, party: null })
  })

  it("sends null for a provider's people that carry no party today", async () => {
    await seedBill([{ peopleId: 7, name: 'Delegate Crane', provider: 'mga' }, { peopleId: 8, name: 'Lin Frost', provider: 'lis' }], { provider: 'mga', state: 'MD' })
    const { party } = await voters()
    expect(party('Delegate Crane')).toBeNull()
    expect(party('Lin Frost')).toBeNull()
  })

  it('sends the current party on the people record, as stored, for an unusual code', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', party: 'Green' }])
    const { party } = await voters()
    expect(party('Ana Diaz')).toBe('Green')
  })

  it('keeps the voter order and the other fields unchanged', async () => {
    await seedBill([{ peopleId: 2, name: 'Ben Cole', party: 'R' }, { peopleId: 1, name: 'Ana Diaz', party: 'D' }])
    const { list } = await voters()
    expect(list).toEqual([
      { personId: '1', name: 'Ana Diaz', vote: 'Yea', url: null, party: 'D' },
      { personId: '2', name: 'Ben Cole', vote: 'Yea', url: null, party: 'R' },
    ])
  })
})
