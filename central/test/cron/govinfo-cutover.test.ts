import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'

// A cutover of Congress from LegiScan to GovInfo, for legislators (#912).
// GovInfo lists no people, so its plan used to see only the sponsors of the
// bills it read, and every other LegiScan legislator with a Bioguide id got a
// second `people` row the first time a GovInfo bill or vote named them. Now
// GovInfo gives the person id it mints for a Bioguide id
// (`personIdsForBioguide`), and the plan matches every LegiScan legislator who
// holds one. Recorded GovInfo files and roll calls go in, with the network
// stubbed at fetch. The LegiScan side is written as an instance's tracking
// left it, and the people are LegiScan's rows for real members.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { govinfo } from '../../src/providers/govinfo'
import { clearRollCallCaches } from '../../src/providers/govinfo/client'
import { toHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral, type Run } from '../helpers/mainSeam'
import { buildZip, fileType, fixtureFiles, listingResponse, serveZip } from '../helpers/govinfoZip'
import { rollCallBillFiles, rollCallNetwork } from '../helpers/govinfoRollCalls'

const ZIP_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/BILLSTATUS-\d+-([a-z]+)\.zip$/
const FILE_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/(BILLSTATUS-\d+[a-z]+\d+\.xml)$/
const PDF_URL = /^https:\/\/www\.govinfo\.gov\/content\/pkg\/([A-Za-z0-9-]+)\/pdf\/\1\.pdf$/

const seam = mainSeam(govinfo, { tenantId: 'usteam' })
const db = () => drizzle(env.DB, { schema })

// LegiScan's 119th Congress, as an instance has tracked it.
const LS_SESSION = 2140
const US = 52
const HB43 = 3100043        // tracked: the plan reads its file, so its sponsor is seen, and it links House roll call 28
const HB2 = 3100002         // not tracked: the plan never reads it, and its first ingest after the cutover names its sponsor
const BEGICH = 88001        // HB43's sponsor, with no Bioguide id in LegiScan's row, so matched by name as before
const BURCHETT = 88002      // votes on HB43's roll call, sponsors nothing the plan reads
const JOHNSON = 88003       // the Speaker: sponsors only the untracked HB2, and doesn't vote on roll call 28
const GONE = 88004          // a member who left: no bill or vote of GovInfo's names them
const ROSS_A = 88005        // two LegiScan rows sharing one Bioguide id, which matches neither
const ROSS_B = 88006

const ids = { BURCHETT: 'B001309', JOHNSON: 'J000299', GONE: 'Z000999', ROSS: 'Y000005' }

beforeEach(async () => {
  await resetCentral()
  clearRollCallCaches()
  const files = new Map([...fixtureFiles, ...rollCallBillFiles])
  const served = rollCallNetwork()
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    const zip = ZIP_URL.exec(url)
    if (zip && zip[2] === zip[3]) {
      return serveZip(buildZip([...files].filter(([name]) => fileType(name) === zip[2]).map(([name, data]) => ({ name, data }))),
        { headers: { 'last-modified': 'Sat, 17 Oct 2026 00:19:30 GMT' } }).response
    }
    const listing = listingResponse(url, files, () => '2026-07-18T23:27:00Z')
    if (listing) return listing
    const f = FILE_URL.exec(url)
    if (f) {
      const data = files.get(f[3])
      return data === undefined ? new Response('not found', { status: 404 }) : new Response(data, { headers: { 'content-type': 'application/xml' } })
    }
    if (PDF_URL.test(url)) return new Response('%PDF-1.7\n%%EOF\n', { headers: { 'content-type': 'application/pdf' } })
    const answer = served.get(url)
    if (answer) return answer()
    return new Response('not found', { status: 404 })
  })
  await seam.addTenant('US', ['choice for veterans'])

  await db().insert(schema.sessions).values({
    sessionId: LS_SESSION, state: 'US', stateId: US, yearStart: 2025, yearEnd: 2026, special: 0,
    sessionTitle: '119th Congress', sessionName: '119th Congress', sessionTag: '119', slug: '119th-congress',
  })
  const bill = (billId: number, billNumber: string, title: string) =>
    ({ billId, billNumber, title, sessionId: LS_SESSION, state: 'US', stateId: US, changeHash: 'ls-v1', status: 1 })
  await db().insert(schema.bills).values([
    bill(HB43, 'HB43', 'Alaska Native Settlement Trust Eligibility Act'),
    bill(HB2, 'HB2', 'Secure the Border Act of 2025'),
  ])
  await db().insert(schema.billTenants).values({ billId: HB43, tenantId: 'usteam', matchType: 'keyword' })
  const legislator = (peopleId: number, first: string, last: string, bioguideId: string | null) =>
    ({ peopleId, name: `${first} ${last}`, firstName: first, lastName: last, party: 'R', role: 'Rep', roleId: 1, stateId: US, bioguideId })
  await db().insert(schema.people).values([
    legislator(BEGICH, 'Nicholas', 'Begich', null),
    legislator(BURCHETT, 'Tim', 'Burchett', ids.BURCHETT),
    legislator(JOHNSON, 'Mike', 'Johnson', ids.JOHNSON),
    legislator(GONE, 'Pat', 'Gone', ids.GONE),
    legislator(ROSS_A, 'Gil', 'Ross', ids.ROSS),
    legislator(ROSS_B, 'Gil', 'Ross', ids.ROSS),
  ])
  await db().insert(schema.billSponsors).values({ id: 'ls-hb43-1', billId: HB43, peopleId: BEGICH, sponsorTypeId: 1, sponsorOrder: 1 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const cutover = (query = '', run?: Run) => seam.central('POST', `/admin/state-providers/US/cutover${query}`, run, { provider: 'govinfo' })

async function dryRun() {
  const res = await cutover()
  const body = await res.json() as any
  expect(res.status, JSON.stringify(body)).toBe(200)
  return body
}

/** Every table a plan could write, other than the call log and the provider's cache. */
async function snapshotTables() {
  const tables = ['bills', 'bill_tenants', 'bill_sponsors', 'sessions', 'people', 'provider_ids', 'provider_records',
    'state_providers', 'cutovers', 'cutover_bills', 'cutover_people', 'roll_calls', 'roll_call_votes']
  const out: Record<string, unknown[]> = {}
  for (const t of tables) out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results
  return out
}

const byBioguide = async (id: string) =>
  (await env.DB.prepare('SELECT people_id, provider FROM people WHERE bioguide_id = ? ORDER BY people_id').bind(id).all<any>()).results

/** Cut over, then consume every ingest the cutover's first sync queued, as the queue consumer would. */
async function cutOverAndIngest() {
  const run = seam.makeRun()
  const res = await cutover('?confirm=true', run)
  const body = await res.json() as any
  expect(res.status, JSON.stringify(body)).toBe(200)
  expect(body.sync?.error, JSON.stringify(body.sync)).toBeUndefined()
  const queued = seam.queued(run)
  expect(queued.map(m => m.billId)).toEqual(expect.arrayContaining([HB43, HB2]))
  const messages = await seam.ingest([HB43, HB2], run)
  for (const m of messages) expect(m.retry, JSON.stringify(m.body)).not.toHaveBeenCalled()
  return body
}

describe('a cutover of Congress to GovInfo', () => {
  it('matches every LegiScan legislator with a Bioguide id in the dry run, not only the sponsors it reads', async () => {
    const body = await dryRun()
    const listed = (id: number) => body.people.list.find((m: any) => m.personId === String(id))
    for (const id of [BURCHETT, JOHNSON, GONE]) {
      expect(listed(id), `person ${id}`).toMatchObject({ on: ['bioguide'], nameMatch: null, weak: false })
    }
    // GovInfo names no one without reading a file, so a legislator matched only by the id shows LegiScan's name.
    expect(listed(JOHNSON).as).toBe('Mike Johnson')
    const unmatchedOld = body.people.unmatched.old.map((p: any) => p.personId)
    for (const id of [BURCHETT, JOHNSON, GONE]) expect(unmatchedOld).not.toContain(String(id))
    expect(body.people.bioguide).toBe(3)
  })

  it('still matches a legislator with no Bioguide id by name, through the sponsors of the bills it reads', async () => {
    const body = await dryRun()
    expect(body.people.list.find((m: any) => m.personId === String(BEGICH))).toMatchObject({ name: 'Nicholas Begich', nameMatch: 'full' })
  })

  it('matches neither of two LegiScan rows sharing a Bioguide id, as before', async () => {
    const body = await dryRun()
    const unmatchedOld = body.people.unmatched.old.map((p: any) => p.personId)
    expect(unmatchedOld).toEqual(expect.arrayContaining([String(ROSS_A), String(ROSS_B)]))
    expect(body.people.sharedBioguide).toEqual([
      { side: 'old', bioguideId: ids.ROSS, people: [{ personId: String(ROSS_A), name: 'Gil Ross' }, { personId: String(ROSS_B), name: 'Gil Ross' }] },
    ])
  })

  it('writes nothing in a dry run but the call log and the provider\'s cache', async () => {
    const before = await snapshotTables()
    await dryRun()
    expect(await snapshotTables()).toEqual(before)
  })

  it('resolves a GovInfo vote and sponsor to the kept LegiScan person, with no second row for the Bioguide id', async () => {
    const reported = await dryRun()
    const body = await cutOverAndIngest()
    expect(body.people.matched).toBe(reported.people.matched)

    // Burchett's vote on HB43's roll call is under his kept id.
    const hb43 = await seam.getJson(`/bills/${toHandle(HB43)}`)
    const voters = hb43.votes.flatMap((v: any) => v.legislatorVotes ?? [])
    expect(voters.some((v: any) => v.personId === String(BURCHETT))).toBe(true)
    // Johnson sponsors the untracked HB2, which only its first ingest after the cutover reads.
    const [sponsor] = await env.DB.prepare('SELECT people_id FROM bill_sponsors WHERE bill_id = ? AND sponsor_type_id = 1').bind(HB2).all<any>()
      .then(r => r.results)
    expect(sponsor.people_id).toBe(JOHNSON)

    expect(await byBioguide(ids.BURCHETT)).toEqual([{ people_id: BURCHETT, provider: 'govinfo' }])
    expect(await byBioguide(ids.JOHNSON)).toEqual([{ people_id: JOHNSON, provider: 'govinfo' }])
    expect(await byBioguide(ids.GONE)).toEqual([{ people_id: GONE, provider: 'govinfo' }])
    // The legislator with no Bioguide id in LegiScan's row was matched by name, and the ingest stored GovInfo's id on the kept row.
    expect(await byBioguide('B001323')).toEqual([{ people_id: BEGICH, provider: 'govinfo' }])
  })

  it('gives the legislators matched only by Bioguide id back to LegiScan on an undo', async () => {
    await cutOverAndIngest()
    const res = await seam.central('POST', '/admin/state-providers/US/undo-cutover?confirm=true')
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await byBioguide(ids.GONE)).toEqual([{ people_id: GONE, provider: 'legiscan' }])
    expect(await byBioguide(ids.JOHNSON)).toEqual([{ people_id: JOHNSON, provider: 'legiscan' }])
  })
})
