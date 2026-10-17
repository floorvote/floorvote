import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

beforeEach(async () => {
  await setupLsDb()
})

const bio = (url: string) => JSON.stringify({ social: { biography: url } })
const LEGISCAN_PAGE = (state: string, name: string, id: number) => `https://legiscan.com/${state}/people/${name.replace(/ /g, '-')}/id/${id}`

type PersonSeed = { peopleId: number; name: string; provider?: string; ballotpedia?: string | null; bioJson?: string | null }

/**
 * One bill whose sponsors and roll call voters are the given people, in the
 * given provider's bill. Every person sponsors the bill and votes Yea on its
 * one roll call, so a person's sponsor link and voter link can be compared.
 */
async function seedBill(people: PersonSeed[], opts: { provider?: string; state?: string } = {}) {
  const db = drizzle(env.DB, { schema })
  const provider = opts.provider ?? 'legiscan'
  const state = opts.state ?? 'RI'
  await db.insert(schema.sessions).values({ sessionId: 1, state, stateId: 39, yearStart: 2026, yearEnd: 2026, sessionName: `${state} 2026`, sessionTitle: 'Regular' })
  await db.insert(schema.bills).values({ billId: 101, sessionId: 1, state, stateId: 0, billNumber: 'H101', title: 'Bill 101', changeHash: 'h', status: 1, provider })
  for (const p of people) {
    await db.insert(schema.people).values({
      peopleId: p.peopleId, name: p.name, stateId: 0, provider: p.provider ?? provider,
      ballotpedia: p.ballotpedia ?? null, bioJson: p.bioJson ?? null,
    } as any)
  }
  await db.insert(schema.billSponsors).values(people.map((p, i) => ({ id: `s${p.peopleId}`, billId: 101, peopleId: p.peopleId, sponsorTypeId: i === 0 ? 1 : 2, sponsorOrder: i })))
  await db.insert(schema.rollCalls).values({ rollCallId: 31, billId: 101, date: '2026-01-05', description: 'Passage', yea: people.length, nay: 0, nv: 0, absent: 0, total: people.length, passed: 1, chamber: 'H' })
  await db.insert(schema.rollCallVotes).values(people.map(p => ({ id: `v${p.peopleId}`, rollCallId: 31, peopleId: p.peopleId, voteId: 1, voteText: 'Yea' })))
}

async function detail() {
  const res = await app.request('/api/bills/legiscan:101', { headers: { 'x-admin-secret': 'test-secret' } }, env)
  expect(res.status).toBe(200)
  const body = await res.json() as any
  const sponsorUrl = (name: string) => body.sponsors.find((s: any) => s.name === name).url as string | null
  const voterUrl = (name: string) => body.votes[0].legislatorVotes.find((v: any) => v.name === name).url as string | null | undefined
  return { body, sponsorUrl, voterUrl }
}

describe('legislator profile links: LegiScan people', () => {
  const people: PersonSeed[] = [
    { peopleId: 1, name: 'Ana Diaz', bioJson: bio('https://legislature.example/members/diaz'), ballotpedia: 'Ana_Diaz' },
    { peopleId: 2, name: 'Ben Cole', ballotpedia: 'Ben_Cole' },
    { peopleId: 3, name: 'Cy Park' },
  ]

  it('links a sponsor and a voter with an official bio page to it, even when Ballotpedia is also stored', async () => {
    await seedBill(people)
    const { sponsorUrl, voterUrl } = await detail()
    expect(sponsorUrl('Ana Diaz')).toBe('https://legislature.example/members/diaz')
    expect(voterUrl('Ana Diaz')).toBe('https://legislature.example/members/diaz')
  })

  it('links a person with only a Ballotpedia id to Ballotpedia, as a sponsor and as a voter', async () => {
    await seedBill(people)
    const { sponsorUrl, voterUrl } = await detail()
    expect(sponsorUrl('Ben Cole')).toBe('https://ballotpedia.org/Ben_Cole')
    expect(voterUrl('Ben Cole')).toBe('https://ballotpedia.org/Ben_Cole')
  })

  it('keeps the legiscan.com page as the sponsor last resort, and leaves a voter with neither plain', async () => {
    await seedBill(people)
    const { sponsorUrl, voterUrl } = await detail()
    expect(sponsorUrl('Cy Park')).toBe(LEGISCAN_PAGE('RI', 'Cy Park', 3))
    expect(voterUrl('Cy Park')).toBeNull()
  })

  it('sends a url on every voter, null where there is none', async () => {
    await seedBill(people)
    const { body } = await detail()
    expect(body.votes[0].legislatorVotes.map((v: any) => [v.name, v.url])).toEqual([
      ['Ana Diaz', 'https://legislature.example/members/diaz'],
      ['Ben Cole', 'https://ballotpedia.org/Ben_Cole'],
      ['Cy Park', null],
    ])
  })

  it('encodes a Ballotpedia page name so it stays one path segment', async () => {
    await seedBill([{ peopleId: 4, name: 'Jo Nuñez', ballotpedia: 'Jo Nuñez/Jr' }])
    const { sponsorUrl, voterUrl } = await detail()
    expect(voterUrl('Jo Nuñez')).toBe('https://ballotpedia.org/Jo%20Nu%C3%B1ez%2FJr')
    expect(sponsorUrl('Jo Nuñez')).toBe('https://ballotpedia.org/Jo%20Nu%C3%B1ez%2FJr')
  })

  it('treats a blank Ballotpedia id as none', async () => {
    await seedBill([{ peopleId: 5, name: 'Di Wu', ballotpedia: '   ' }])
    const { sponsorUrl, voterUrl } = await detail()
    expect(voterUrl('Di Wu')).toBeNull()
    expect(sponsorUrl('Di Wu')).toBe(LEGISCAN_PAGE('RI', 'Di Wu', 5))
  })

  it('leaves a voter with no people row plain, and still lists them', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', ballotpedia: 'Ana_Diaz' }])
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.rollCallVotes).values({ id: 'v-orphan', rollCallId: 31, peopleId: 999, voteId: 1, voteText: 'Nay' })
    const { body } = await detail()
    expect(body.votes[0].legislatorVotes).toContainEqual({ personId: '999', name: '999', vote: 'Nay', url: null })
  })
})

describe('legislator profile links: only http and https are sent', () => {
  it('never sends a javascript: or data: bio page, and falls through to Ballotpedia', async () => {
    await seedBill([
      { peopleId: 1, name: 'Ana Diaz', bioJson: bio('javascript:alert(1)'), ballotpedia: 'Ana_Diaz' },
      { peopleId: 2, name: 'Ben Cole', bioJson: bio('data:text/html,<script>alert(1)</script>'), ballotpedia: 'Ben_Cole' },
    ])
    const { sponsorUrl, voterUrl } = await detail()
    for (const name of ['Ana Diaz', 'Ben Cole']) {
      expect(sponsorUrl(name)).toBe(`https://ballotpedia.org/${name.replace(' ', '_')}`)
      expect(voterUrl(name)).toBe(`https://ballotpedia.org/${name.replace(' ', '_')}`)
    }
  })

  it('sends a voter with only an unsafe bio page no url, and a sponsor the last resort', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', bioJson: bio('javascript:alert(1)') }])
    const { sponsorUrl, voterUrl } = await detail()
    expect(voterUrl('Ana Diaz')).toBeNull()
    expect(sponsorUrl('Ana Diaz')).toBe(LEGISCAN_PAGE('RI', 'Ana Diaz', 1))
  })

  it('never sends a relative or protocol-less bio page', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', bioJson: bio('/members/diaz') }, { peopleId: 2, name: 'Ben Cole', bioJson: bio('legislature.example/diaz') }])
    const { sponsorUrl, voterUrl } = await detail()
    expect(voterUrl('Ana Diaz')).toBeNull()
    expect(voterUrl('Ben Cole')).toBeNull()
    expect(sponsorUrl('Ana Diaz')).toBe(LEGISCAN_PAGE('RI', 'Ana Diaz', 1))
  })

  it('ignores a bio_json that is not JSON', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', bioJson: '{not json', ballotpedia: 'Ana_Diaz' }])
    const { sponsorUrl, voterUrl } = await detail()
    expect(voterUrl('Ana Diaz')).toBe('https://ballotpedia.org/Ana_Diaz')
    expect(sponsorUrl('Ana Diaz')).toBe('https://ballotpedia.org/Ana_Diaz')
  })

  it('never sends an unsafe bio page for a provider that declares no profile url', async () => {
    await seedBill([{ peopleId: 1, name: 'Ana Diaz', provider: 'mga', bioJson: bio('javascript:alert(1)') }], { provider: 'mga', state: 'MD' })
    const { sponsorUrl } = await detail()
    expect(sponsorUrl('Ana Diaz')).toBeNull()
  })
})

describe('legislator profile links: other providers are unchanged', () => {
  const DC_PAGE = 'https://dccouncil.gov/councilmembers/'

  it('links a DC sponsor to the councilmembers page as today, and leaves a DC voter plain', async () => {
    await seedBill([{ peopleId: 1000000189, name: 'Cora Vale', provider: 'lims', bioJson: bio(DC_PAGE) }], { provider: 'lims', state: 'DC' })
    const { sponsorUrl, voterUrl } = await detail()
    expect(sponsorUrl('Cora Vale')).toBe(DC_PAGE)
    expect(voterUrl('Cora Vale')).toBeNull()
  })

  it('leaves Maryland and Virginia people plain as sponsors and voters', async () => {
    await seedBill([{ peopleId: 7, name: 'Delegate Crane', provider: 'mga' }, { peopleId: 8, name: 'Lin Frost', provider: 'lis' }], { provider: 'mga', state: 'MD' })
    const { sponsorUrl, voterUrl } = await detail()
    expect(sponsorUrl('Delegate Crane')).toBeNull()
    expect(sponsorUrl('Lin Frost')).toBeNull()
    expect(voterUrl('Delegate Crane')).toBeNull()
    expect(voterUrl('Lin Frost')).toBeNull()
  })

  it('does not give a non-LegiScan person a Ballotpedia link even when one is stored', async () => {
    await seedBill([{ peopleId: 7, name: 'Delegate Crane', provider: 'mga', ballotpedia: 'Delegate_Crane' }], { provider: 'mga', state: 'MD' })
    const { sponsorUrl, voterUrl } = await detail()
    expect(sponsorUrl('Delegate Crane')).toBeNull()
    expect(voterUrl('Delegate Crane')).toBeNull()
  })

  it('still uses a stored bio page for a sponsor of a provider that declares nothing, as today', async () => {
    await seedBill([{ peopleId: 7, name: 'Delegate Crane', provider: 'mga', bioJson: bio('https://mga.example/crane') }], { provider: 'mga', state: 'MD' })
    const { sponsorUrl, voterUrl } = await detail()
    expect(sponsorUrl('Delegate Crane')).toBe('https://mga.example/crane')
    expect(voterUrl('Delegate Crane')).toBeNull()
  })
})
