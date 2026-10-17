import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'

// Roll calls from GovInfo Bill Status at the main seam (#618): each recorded
// vote a tracked bill's file links is read from the House Clerk's or the
// Senate's own roll call file at ingest, and central's bill API serves it with
// every member's vote. Recorded real files go in (the bill, its roll calls,
// senate.gov's member list, and congress-legislators' historical file), with
// the network stubbed at fetch, and the bill API plus the tables an ingest
// writes come out.
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
import { mainSeam, resetCentral } from '../helpers/mainSeam'
import { buildZip, fileType, fixtureFiles, serveZip } from '../helpers/govinfoZip'
import {
  CVC_URL, HISTORICAL_URL, cvcFile, historicalFile, houseUrl, isRollCallHost, rollCallBillFiles, rollCallFiles, rollCallNetwork, senateUrl,
} from '../helpers/govinfoRollCalls'

const ZIP_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/BILLSTATUS-\d+-([a-z]+)\.zip$/
const FILE_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/(BILLSTATUS-\d+[a-z]+\d+\.xml)$/
const PDF_URL = /^https:\/\/www\.govinfo\.gov\/content\/pkg\/([A-Za-z0-9-]+)\/pdf\/\1\.pdf$/

/** The Bill Status files the stubbed GovInfo serves, by file name: every recorded bill, and the ones added for roll calls. */
let files: Map<string, string>
/** What the stubbed network answers for the roll call and member files, by address. A test replaces entries. */
let served: Map<string, () => Response>
let calls: string[]

const seam = mainSeam(govinfo, { tenantId: 'usteam' })
const { makeRun, getJson, sync, syncAndIngest, queuedIds } = seam
const billId = (number: string) => seam.billIdOf(number)
const bill = async (number: string) => getJson(`/bills/${toHandle(await billId(number))}`)
const db = () => drizzle(env.DB, { schema })

const file = (name: string) => `BILLSTATUS-119${name}.xml`
const xml = (name: string) => files.get(file(name))!
/** A recorded bill file with a change made to its text. The change must apply, or the test is testing nothing. */
const edit = (name: string, change: (x: string) => string) => {
  const before = xml(name)
  const after = change(before)
  expect(after, `the edit to ${name} changed nothing`).not.toBe(before)
  files.set(file(name), after)
}
/** A roll call file the network serves, with a change made to its text. */
const editRoll = (url: string, change: (x: string) => string) => {
  const before = served.get(url)
  expect(before, `${url} isn't served`).toBeDefined()
  let text = ''
  return before!().text().then(t => {
    text = t
    const after = change(text)
    expect(after, `the edit to ${url} changed nothing`).not.toBe(text)
    served.set(url, () => new Response(after, { status: 200, headers: { 'content-type': 'application/xml' } }))
  })
}
const rollText = (url: string) => served.get(url)!().text()

const HJR35 = { house: houseUrl(2025, 52), senate: senateUrl(119, 1, 97) }
const HJR140 = { house: houseUrl(2026, 38), senate: [senateUrl(119, 2, 82), senateUrl(119, 2, 83), senateUrl(119, 2, 84)] }
const HR580 = [houseUrl(2025, 194), houseUrl(2025, 195), houseUrl(2025, 197), houseUrl(2025, 198)]
const HB43 = houseUrl(2025, 28)

function serveZips() {
  return (type: string) => serveZip(buildZip(
    [...files].filter(([name]) => fileType(name) === type).map(([name, data]) => ({ name, data })),
  ), { headers: { 'last-modified': 'Sat, 17 Oct 2026 00:19:30 GMT' } }).response
}

beforeEach(async () => {
  await resetCentral()
  clearRollCallCaches()
  files = new Map([...fixtureFiles, ...rollCallBillFiles])
  served = rollCallNetwork()
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    const zip = ZIP_URL.exec(url)
    if (zip && zip[2] === zip[3]) return serveZips()(zip[2])
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
  await seam.claim('US', 'govinfo')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Sync Congress, then ingest the bills with these numbers. */
async function ingest(...numbers: string[]) {
  await sync()
  const messages = await seam.ingest(await Promise.all(numbers.map(billId)))
  for (const m of messages) expect(m.retry, JSON.stringify(m.body)).not.toHaveBeenCalled()
  return messages
}

/** The same, for an ingest failing closed: the message must be retried, and the error is returned for what it names. */
async function ingestFailing(...numbers: string[]) {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  await sync()
  const messages = await seam.ingest(await Promise.all(numbers.map(billId)))
  for (const m of messages) expect(m.retry, 'the ingest should be retried').toHaveBeenCalled()
  return errors.mock.calls.flat().map(a => (a instanceof Error ? a.message : String(a))).join('\n')
}

const rollCallRows = () => db().select().from(schema.rollCalls).all()
const voteRows = () => db().select().from(schema.rollCallVotes).all()

/** Everything an ingest writes for a bill, and the ids it mints, so a failing ingest can be shown to have left none. */
async function nothingWritten() {
  const d = db()
  expect(await rollCallRows(), 'roll calls').toEqual([])
  expect(await voteRows(), 'member votes').toEqual([])
  for (const [table, rows] of Object.entries({
    history: await d.select().from(schema.billHistory).all(),
    sponsors: await d.select().from(schema.billSponsors).all(),
    people: await d.select().from(schema.people).all(),
    texts: await d.select().from(schema.billTexts).all(),
  })) expect(rows, table).toEqual([])
  const minted = await d.select().from(schema.providerIds).all()
  expect(minted.filter(m => ['person', 'doc', 'committee', 'subject', 'rollcall'].includes(m.kind)), 'minted ids').toEqual([])
}

// ---- What the recorded roll call files say, read here with plain patterns so the checks don't share the provider's reader.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const text = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? ''

function houseRoll(xml: string) {
  const totals = /<totals-by-vote>([\s\S]*?)<\/totals-by-vote>/.exec(xml)![1]
  const n = (tag: string) => Number(text(totals, tag))
  const d = /^(\d+)-(\w{3})-(\d{4})$/.exec(text(xml, 'action-date'))!
  return {
    yea: n('yea-total'), nay: n('nay-total'), notVoting: n('not-voting-total'), present: n('present-total'),
    date: `${d[3]}-${String(MONTHS.indexOf(d[2]) + 1).padStart(2, '0')}-${d[1].padStart(2, '0')}`,
    question: text(xml, 'vote-question'),
    result: text(xml, 'vote-result'),
    members: [...xml.matchAll(/<recorded-vote>\s*<legislator name-id="([^"]+)"[^>]*party="([^"]*)" state="([^"]*)"[^>]*>([^<]*)<\/legislator>\s*<vote>([^<]*)<\/vote>/g)]
      .map(m => ({ bioguide: m[1], party: m[2], state: m[3], name: m[4], vote: m[5] })),
  }
}

function senateRoll(xml: string) {
  const count = /<count>([\s\S]*?)<\/count>/.exec(xml)![1]
  const n = (tag: string) => Number(text(count, tag) || 0)
  const d = /^(\w+) (\d+), (\d{4})/.exec(text(xml, 'vote_date'))!
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(d[1]) + 1
  return {
    yeas: n('yeas'), nays: n('nays'), present: n('present'), absent: n('absent'),
    date: `${d[3]}-${String(month).padStart(2, '0')}-${d[2].padStart(2, '0')}`,
    question: text(xml, 'vote_question_text'),
    result: text(xml, 'vote_result'),
    members: [...xml.matchAll(/<member>[\s\S]*?<last_name>([^<]*)<\/last_name>\s*<first_name>([^<]*)<\/first_name>\s*<party>([^<]*)<\/party>\s*<state>([^<]*)<\/state>\s*<vote_cast>([^<]*)<\/vote_cast>\s*<lis_member_id>([^<]*)<\/lis_member_id>/g)]
      .map(m => ({ last: m[1], first: m[2], party: m[3], state: m[4], vote: m[5], lis: m[6] })),
  }
}

/** A bill's roll calls from the bill API, after checking that it serves this many. */
async function rollsOf(number: string, n: number): Promise<any[]> {
  const { votes } = await bill(number)
  expect(votes, `${number}'s roll calls`).toHaveLength(n)
  return votes
}

const count = (roll: any, option: string): number => roll.counts.find((c: any) => c.option === option).value

/** The bioguide id of each person central has, by central person id. */
async function bioguideOf(): Promise<Map<string, string>> {
  return new Map((await db().select().from(schema.people).all()).map(p => [String(p.peopleId), p.bioguideId ?? '']))
}

describe('a bill with one House and one Senate recorded vote', () => {
  it('serves two roll calls with the yea, nay, not voting, and absent counts the files give', async () => {
    await ingest('HJR35')
    const { votes } = await bill('HJR35')
    expect(votes).toHaveLength(2)
    const house = houseRoll(await rollText(HJR35.house))
    const senate = senateRoll(await rollText(HJR35.senate))
    const h = votes.find((v: any) => v.chamber === 'H')
    const s = votes.find((v: any) => v.chamber === 'S')
    // The House counts "Present" with not voting, and has no absent. The recorded House vote here has one "Present".
    expect(house.present).toBe(1)
    expect([count(h, 'yes'), count(h, 'no'), count(h, 'not voting'), count(h, 'absent')]).toEqual([house.yea, house.nay, house.notVoting + house.present, 0])
    // The Senate gives an absent count of its own.
    expect([count(s, 'yes'), count(s, 'no'), count(s, 'not voting'), count(s, 'absent')]).toEqual([senate.yeas, senate.nays, senate.present, senate.absent])
    expect(senate.absent).toBeGreaterThan(0)
  })

  it('gives each roll call its question, its day, its result, and its chamber', async () => {
    await ingest('HJR35')
    const { votes } = await bill('HJR35')
    const house = houseRoll(await rollText(HJR35.house))
    const senate = senateRoll(await rollText(HJR35.senate))
    expect(votes.find((v: any) => v.chamber === 'H')).toMatchObject({ motionText: 'On Passage', date: house.date, result: 'pass' })
    expect(house.result).toBe('Passed')
    expect(votes.find((v: any) => v.chamber === 'S')).toMatchObject({ motionText: senate.question, date: senate.date, result: 'pass' })
    expect(senate.question).toMatch(/^On the Joint Resolution/)
  })

  it('serves every member vote of each roll call, by name', async () => {
    await ingest('HJR35')
    const votes = await rollsOf('HJR35', 2)
    const house = houseRoll(await rollText(HJR35.house))
    const senate = senateRoll(await rollText(HJR35.senate))
    const h = votes.find((v: any) => v.chamber === 'H')
    const s = votes.find((v: any) => v.chamber === 'S')
    expect(h.legislatorVotes).toHaveLength(house.members.length)
    expect(s.legislatorVotes).toHaveLength(senate.members.length)
    // No member is shown by a number: each has a name.
    for (const v of [...h.legislatorVotes, ...s.legislatorVotes]) expect(v.name, JSON.stringify(v)).not.toMatch(/^\d+$/)
    const adams = house.members.find(m => m.name === 'Adams')!
    expect(h.legislatorVotes).toContainEqual(expect.objectContaining({ name: 'Adams', vote: adams.vote === 'Aye' ? 'Yea' : adams.vote }))
    expect(s.legislatorVotes).toContainEqual(expect.objectContaining({ name: 'Angela Alsobrooks', vote: 'Nay' }))
  })

  it('keeps the member votes in central\'s tables, one row for each member of each roll call', async () => {
    await ingest('HJR35')
    const rolls = await rollCallRows()
    expect(rolls).toHaveLength(2)
    const house = houseRoll(await rollText(HJR35.house))
    const senate = senateRoll(await rollText(HJR35.senate))
    const rows = await voteRows()
    expect(rows).toHaveLength(house.members.length + senate.members.length)
    for (const r of rolls) expect(rows.filter(v => v.rollCallId === r.rollCallId).length, String(r.rollCallId)).toBe(r.chamber === 'H' ? house.members.length : senate.members.length)
  })
})

describe('House votes', () => {
  it('gives a House member the same person id as their sponsorship of another bill', async () => {
    await ingest('HB3132', 'HB43')
    const bio = await bioguideOf()
    // B001309 sponsors or cosponsors HB3132 and votes on HB43's roll call.
    const sponsorship = (await bill('HB3132')).sponsors.find((s: any) => bio.get(s.personId) === 'B001309')
    const voted = (await rollsOf('HB43', 1))[0].legislatorVotes.find((v: any) => bio.get(v.personId) === 'B001309')
    expect(sponsorship?.personId).toBeTruthy()
    expect(voted?.personId).toBe(sponsorship.personId)
    expect((await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'B001309')).all())).toHaveLength(1)
  })

  it('names each voter by their Bioguide id, so every voter has the person id the id gives', async () => {
    await ingest('HB43')
    const house = houseRoll(await rollText(HB43))
    const bio = await bioguideOf()
    const votes = await rollsOf('HB43', 1)
    expect(votes[0].legislatorVotes.map((v: any) => bio.get(v.personId)).sort()).toEqual(house.members.map(m => m.bioguide).sort())
  })

  it('keeps a voter nobody has sponsored with, under the name the Clerk gives, and as a person', async () => {
    await ingest('HB43')
    const house = houseRoll(await rollText(HB43))
    const voter = house.members[0]
    const rows = await db().select().from(schema.people).where(eq(schema.people.bioguideId, voter.bioguide)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: voter.name, party: voter.party, stateId: 52, provider: 'govinfo', role: 'Rep', roleId: 1 })
    const votes = await rollsOf('HB43', 1)
    expect(votes[0].legislatorVotes).toContainEqual({ personId: String(rows[0].peopleId), name: voter.name, vote: expect.any(String) })
  })

  it('shows each voter under the name the Clerk prints, including its state when two members share a last name', async () => {
    await ingest('HB43')
    const house = houseRoll(await rollText(HB43))
    expect(house.members.some(m => /\([A-Z]{2}\)$/.test(m.name))).toBe(true)
    const bio = await bioguideOf()
    const votes = (await rollsOf('HB43', 1))[0].legislatorVotes
    // A member who also sponsors the bill is named as the bill's own file names them, which is fuller.
    const sponsors = new Set((await bill('HB43')).sponsors.map((s: any) => bio.get(s.personId)))
    const others = house.members.filter(m => !sponsors.has(m.bioguide))
    expect(others.length).toBeGreaterThan(20)
    expect(votes.filter((v: any) => !sponsors.has(bio.get(v.personId))).map((v: any) => v.name).sort()).toEqual(others.map(m => m.name).sort())
  })

  it('leaves a sponsor\'s fuller record alone when a roll call names the same member by their last name', async () => {
    await ingest('HB3132', 'HB43')
    await rollsOf('HB43', 1)
    const [row] = await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'B001309')).all()
    // The Bill Status feed gives a first and last name; the Clerk gives the last name alone.
    expect(row.firstName).toBeTruthy()
    expect(row.name).toBe(`${row.firstName}${row.middleName ? ` ${row.middleName}` : ''} ${row.lastName}`)
    expect(row.district).toMatch(/^[A-Z]{2}-(\d+|AL)$/)
  })

  it('fills in a member the roll call named first, with the sponsor record when a later bill names them as a sponsor', async () => {
    await ingest('HB43')
    const [first] = await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'B001309')).all()
    expect(first, 'the roll call makes the voter a person').toBeDefined()
    expect(first.firstName).toBeNull()
    await ingest('HB3132')
    const [after] = await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'B001309')).all()
    expect(after.peopleId).toBe(first.peopleId)
    expect(after.firstName).toBeTruthy()
    expect(after.district).toMatch(/^[A-Z]{2}-/)
  })

  it('reads the Clerk\'s "Aye" and "No" as Yea and Nay, so a roll call reads the same either way', async () => {
    await ingest('HR580')
    const votes = await rollsOf('HR580', 4)
    const words = new Set(votes.flatMap((v: any) => v.legislatorVotes.map((l: any) => l.vote)))
    expect([...words].sort()).toEqual(['Nay', 'Not Voting', 'Yea'])
    const roll = houseRoll(await rollText(HR580[1]))
    expect(roll.members.some(m => m.vote === 'Aye') && roll.members.some(m => m.vote === 'No')).toBe(true)
    const v = votes.find((x: any) => x.motionText === 'On Agreeing to the Resolution' && x.date === roll.date && count(x, 'yes') === roll.yea)
    expect(v.legislatorVotes.filter((l: any) => l.vote === 'Yea')).toHaveLength(roll.members.filter(m => m.vote === 'Aye').length)
  })

  it('serves "Present" as not voting, with "Present" kept as the vote text', async () => {
    await ingest('HB131')
    const house = houseRoll(await rollText(houseUrl(2026, 9)))
    expect(house.present).toBe(1)
    const votes = await rollsOf('HB131', 1)
    expect(count(votes[0], 'not voting')).toBe(house.notVoting + house.present)
    const present = votes[0].legislatorVotes.filter((l: any) => l.vote === 'Present')
    expect(present).toHaveLength(house.members.filter(m => m.vote === 'Present').length)
    expect(present.length).toBeGreaterThan(0)
    const rows = await voteRows()
    // vote_id 3 is "not voting", whatever the vote text says.
    expect(rows.filter(r => r.voteText === 'Present').map(r => r.voteId)).toEqual(present.map(() => 3))
    expect(rows.filter(r => r.voteText === 'Not Voting').every(r => r.voteId === 3)).toBe(true)
    expect(rows.filter(r => r.voteText === 'Yea').every(r => r.voteId === 1)).toBe(true)
    expect(rows.filter(r => r.voteText === 'Nay').every(r => r.voteId === 2)).toBe(true)
  })
})

describe('Senate votes', () => {
  /** The member list with the four senators who left the 119th Congress added, as it would be before they left. */
  function cvcWithLeavers(): string {
    const leavers = [['S293', 'Lindsey', 'Graham', 'R', 'SC', 'G000359'], ['S419', 'Markwayne', 'Mullin', 'R', 'OK', 'M001190'],
      ['S350', 'Marco', 'Rubio', 'R', 'FL', 'R000595'], ['S421', 'James David', 'Vance', 'R', 'OH', 'V000137']]
    const blocks = leavers.map(([lis, first, last, party, state, bio]) =>
      `<senator lis_member_id="${lis}">\n<name>\n<prefix>Mr.</prefix>\n<first>${first}</first>\n<last>${last}</last>\n<suffix>        \n</suffix>\n</name>\n<party>${party}</party>\n<state>${state}</state>\n<bioguideId>${bio}</bioguideId>\n</senator>`).join('\n')
    return cvcFile.replace('</senators>', `${blocks}\n</senators>`)
  }

  it('maps a sitting senator\'s vote through senate.gov\'s member list, and never fetches the historical file', async () => {
    served.set(CVC_URL, () => new Response(cvcWithLeavers(), { status: 200 }))
    await ingest('HJR35')
    await rollsOf('HJR35', 2)
    expect(calls.filter(u => u === CVC_URL)).toHaveLength(1)
    expect(calls).not.toContain(HISTORICAL_URL)
    const senate = senateRoll(await rollText(HJR35.senate))
    const bio = await bioguideOf()
    const votes = await rollsOf('HJR35', 2)
    const s = votes.find((v: any) => v.chamber === 'S')
    expect(s.legislatorVotes).toHaveLength(senate.members.length)
    expect(s.legislatorVotes.map((v: any) => bio.get(v.personId)).every((b: string) => /^[A-Z]\d{6}$/.test(b))).toBe(true)
    expect(s.legislatorVotes.map((v: any) => bio.get(v.personId))).toContain('A000382')
  })

  it('maps a senator the member list lacks through the historical file, fetched once for the whole ingest', async () => {
    await ingest('HJR35', 'HJR140')
    expect(calls.filter(u => u === HISTORICAL_URL)).toHaveLength(1)
    expect(calls.filter(u => u === CVC_URL)).toHaveLength(1)
    const bio = await bioguideOf()
    const votes = await rollsOf('HJR35', 2)
    const s = votes.find((v: any) => v.chamber === 'S')
    // Graham left the 119th Congress, so senate.gov's list no longer has him, and the historical file does.
    expect(s.legislatorVotes.map((v: any) => bio.get(v.personId))).toContain('G000359')
    const second = (await rollsOf('HJR140', 4)).filter((v: any) => v.chamber === 'S')
    expect(second).toHaveLength(3)
    for (const v of second) expect(v.legislatorVotes.map((l: any) => bio.get(l.personId))).toContain('G000359')
  })

  it('gives a senator the same person id as their sponsorship of another bill', async () => {
    await ingest('SB296', 'HJR35')
    const bio = await bioguideOf()
    // S 296's sponsor, B001267, votes on the Senate's roll call of H.J.Res. 35.
    const sponsorship = (await bill('SB296')).sponsors.find((s: any) => s.primary)
    expect(bio.get(sponsorship.personId)).toBe('B001267')
    const voters = (await rollsOf('HJR35', 2)).find((v: any) => v.chamber === 'S').legislatorVotes
    expect(voters.find((v: any) => bio.get(v.personId) === 'B001267')?.personId).toBe(sponsorship.personId)
    expect((await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'B001267')).all())).toHaveLength(1)
  })

  it('names each Senate voter as the senate.gov file does, with their state and party', async () => {
    await ingest('HJR35')
    const senate = senateRoll(await rollText(HJR35.senate))
    const alsobrooks = senate.members.find(m => m.lis === 'S428')!
    const [row] = await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'A000382')).all()
    expect(row).toMatchObject({ name: `${alsobrooks.first} ${alsobrooks.last}`, firstName: alsobrooks.first, lastName: alsobrooks.last, party: alsobrooks.party, district: alsobrooks.state, role: 'Sen', roleId: 2, provider: 'govinfo' })
  })

  it('serves the senators who didn\'t vote as "Not Voting", counted in the absent tally', async () => {
    await ingest('HJR35')
    const senate = senateRoll(await rollText(HJR35.senate))
    const votes = await rollsOf('HJR35', 2)
    const s = votes.find((v: any) => v.chamber === 'S')
    expect(s.legislatorVotes.filter((l: any) => l.vote === 'Not Voting')).toHaveLength(senate.members.filter(m => m.vote === 'Not Voting').length)
    const rows = await voteRows()
    const sRoll = (await rollCallRows()).find(r => r.chamber === 'S')!
    expect(rows.filter(r => r.rollCallId === sRoll.rollCallId && r.voteText === 'Not Voting').every(r => r.voteId === 4)).toBe(true)
    expect(rows.filter(r => r.rollCallId === sRoll.rollCallId && r.voteText === 'Yea').every(r => r.voteId === 1)).toBe(true)
    expect(senate.absent).toBeGreaterThan(0)
  })

  it('serves "Present" as not voting, with "Present" kept as the vote text', async () => {
    await editRoll(HJR35.senate, x => x
      .replace(/<present\/>/, '<present>1</present>')
      .replace(/(<vote_cast>)Nay(<\/vote_cast>)/, '$1Present$2'))
    await ingest('HJR35')
    const senate = senateRoll(await rollText(HJR35.senate))
    expect(senate.present).toBe(1)
    const votes = await rollsOf('HJR35', 2)
    const s = votes.find((v: any) => v.chamber === 'S')
    expect(count(s, 'not voting')).toBe(1)
    expect(s.legislatorVotes.filter((l: any) => l.vote === 'Present')).toHaveLength(1)
    const sRoll = (await rollCallRows()).find(r => r.chamber === 'S')!
    expect((await voteRows()).filter(r => r.rollCallId === sRoll.rollCallId && r.voteText === 'Present').map(r => r.voteId)).toEqual([3])
  })
})

describe('a senator the files don\'t know', () => {
  const unknown = (x: string) => x.replace(/<lis_member_id>S428<\/lis_member_id>/, '<lis_member_id>S999</lis_member_id>')

  it('fails the roll call closed with an error that names the id: the bill is retried and nothing is written', async () => {
    await editRoll(HJR35.senate, unknown)
    const errors = await ingestFailing('HJR35')
    expect(errors).toContain('S999')
    await nothingWritten()
    // Both files were asked, the second only because the first lacked the id.
    expect(calls).toContain(CVC_URL)
    expect(calls).toContain(HISTORICAL_URL)
  })

  it('names every id it can\'t map', async () => {
    await editRoll(HJR35.senate, x => unknown(x).replace(/<lis_member_id>S330<\/lis_member_id>/, '<lis_member_id>S998</lis_member_id>'))
    const errors = await ingestFailing('HJR35')
    expect(errors).toContain('S999')
    expect(errors).toContain('S998')
  })

  it('holds back that bill alone: the next bill ingests', async () => {
    await editRoll(HJR35.senate, unknown)
    await sync()
    const messages = await seam.ingest([await billId('HJR35'), await billId('HB43')])
    expect(messages.map(m => m.retry.mock.calls.length)).toEqual([1, 0])
    expect((await bill('HB43')).votes).toHaveLength(1)
    expect((await bill('HJR35')).votes).toEqual([])
  })

  it.each([
    ['senate.gov\'s member list is missing', () => { served.set(CVC_URL, () => new Response('not found', { status: 404 })) }],
    ['senate.gov\'s member list is a web page', () => { served.set(CVC_URL, () => new Response('<html><body>Down for maintenance</body></html>', { status: 200 })) }],
    ['senate.gov\'s member list is empty of senators', () => { served.set(CVC_URL, () => new Response('<senators></senators>', { status: 200 })) }],
    ['senate.gov\'s member list errors', () => { served.set(CVC_URL, () => new Response('error', { status: 500 })) }],
    ['the historical file is missing', () => { served.set(HISTORICAL_URL, () => new Response('not found', { status: 404 })) }],
    ['the historical file errors', () => { served.set(HISTORICAL_URL, () => new Response('error', { status: 503 })) }],
    ['the historical file is a web page', () => { served.set(HISTORICAL_URL, () => new Response('<html><body>nope</body></html>', { status: 200 })) }],
    ['the historical file has no senators', () => { served.set(HISTORICAL_URL, () => new Response('last_name,first_name\nSmith,Jo\n', { status: 200 })) }],
    ['the historical file is cut off in the middle of a quoted field', () => { served.set(HISTORICAL_URL, () => new Response(historicalFile.slice(0, 600) + '"unfinished', { status: 200 })) }],
  ])('fails closed, writing nothing, when %s', async (_what, change) => {
    change()
    await ingestFailing('HJR35')
    await nothingWritten()
  })

  it('doesn\'t fetch the historical file when senate.gov\'s list knows every voter', async () => {
    await editRoll(HJR35.senate, x => x.replace(/<member>(?:(?!<\/member>)[\s\S])*<lis_member_id>S293<\/lis_member_id>\s*<\/member>\s*/, '').replace(/<member>(?:(?!<\/member>)[\s\S])*<lis_member_id>S419<\/lis_member_id>\s*<\/member>\s*/, ''))
    await ingest('HJR35')
    expect(calls).not.toContain(HISTORICAL_URL)
    expect((await rollsOf('HJR35', 2)).find((v: any) => v.chamber === 'S').legislatorVotes.length).toBeGreaterThan(10)
  })
})

describe('votes on procedure and on amendments, and votes on passage', () => {
  it('serves each roll call a bill\'s actions link, with the question that was put, so a motion to table reads differently from passage', async () => {
    await ingest('HJR140')
    const votes = await rollsOf('HJR140', 4)
    const senateQuestions = await Promise.all(HJR140.senate.map(async u => senateRoll(await rollText(u)).question))
    expect(votes.map((v: any) => v.motionText).sort()).toEqual(['On Passage', ...senateQuestions].sort())
    expect(senateQuestions.filter(q => /Motion to Table/.test(q))).toHaveLength(1)
    expect(senateQuestions.filter(q => /Motion to Proceed/.test(q))).toHaveLength(1)
    expect(senateQuestions.filter(q => /^On the Joint Resolution/.test(q))).toHaveLength(1)
    expect(votes.filter((v: any) => v.chamber === 'H').map((v: any) => v.motionText)).toEqual(['On Passage'])
  })

  it('takes a roll call\'s result from the file, so a failed motion and a passed one differ', async () => {
    await ingest('HR580')
    const votes = await rollsOf('HR580', 4)
    const byQuestion = (q: string) => votes.filter((v: any) => v.motionText === q)
    expect(byQuestion('On Ordering the Previous Question').map((v: any) => v.result)).toEqual(['pass'])
    expect(byQuestion('On Motion to Reconsider').map((v: any) => v.result)).toEqual(['pass'])
    expect(byQuestion('On Agreeing to the Resolution').map((v: any) => v.result).sort()).toEqual(['fail', 'pass'])
  })

  it('reads a Senate motion that was agreed to or rejected from the result the Senate wrote, not from the count alone', async () => {
    await ingest('HJR140')
    const votes = await rollsOf('HJR140', 4)
    const table = votes.find((v: any) => /Motion to Table/.test(v.motionText))
    expect(table.result).toBe('pass')
    await editRoll(HJR140.senate[0], x => x.replace(/Motion to Table Agreed to/g, 'Motion to Table Rejected'))
    clearRollCallCaches()
    await ingest('HJR140')
    expect((await rollsOf('HJR140', 4)).find((v: any) => /Motion to Table/.test(v.motionText)).result).toBe('fail')
  })

  it('serves a failed vote under a suspension of the rules as failed, with the tally the Clerk gave', async () => {
    await ingest('HB9238')
    const votes = await rollsOf('HB9238', 1)
    const house = houseRoll(await rollText(houseUrl(2026, 221)))
    expect(house.result).toBe('Failed')
    expect(votes[0]).toMatchObject({ result: 'fail', motionText: 'On Motion to Suspend the Rules and Pass', date: house.date })
    expect([count(votes[0], 'yes'), count(votes[0], 'no')]).toEqual([house.yea, house.nay])
  })

  it('serves a veto override that failed as failed, whatever its 2/3 count says', async () => {
    await ingest('HB131')
    const votes = await rollsOf('HB131', 1)
    expect(votes[0]).toMatchObject({ result: 'fail' })
    expect(votes[0].motionText).toMatch(/Objections of the President/)
    expect(count(votes[0], 'yes')).toBeGreaterThan(count(votes[0], 'no'))
  })

  it('serves a House vote on a Senate bill', async () => {
    await ingest('SB2503')
    const votes = await rollsOf('SB2503', 1)
    expect(votes[0]).toMatchObject({ chamber: 'H', result: 'fail' })
  })
})

describe('a roll call linked from two bills', () => {
  /** A second House bill that links the same roll call HB43 does. */
  function linkSecondBill() {
    edit('hr837', x => x.replace(/<actions>/, `<actions>
      <item>
        <actionDate>2025-02-04</actionDate>
        <text>On motion to suspend the rules and pass the bill Agreed to by the Yeas and Nays.</text>
        <type>Floor</type>
        <actionCode>8000</actionCode>
        <sourceSystem><code>2</code><name>House floor actions</name></sourceSystem>
        <recordedVotes>
          <recordedVote>
            <rollNumber>28</rollNumber>
            <url>${HB43}</url>
            <chamber>House</chamber>
            <congress>119</congress>
            <date>2025-02-04T23:58:50Z</date>
            <sessionNumber>1</sessionNumber>
          </recordedVote>
        </recordedVotes>
      </item>`))
  }

  it('is fetched once for the ingest and serves on both bills with distinct roll call ids', async () => {
    linkSecondBill()
    await ingest('HB43', 'HB837')
    expect(calls.filter(u => u === HB43)).toHaveLength(1)
    const a = await rollsOf('HB43', 1)
    const b = await rollsOf('HB837', 1)
    expect(a[0].id).not.toBe(b[0].id)
    // The same vote, the same members.
    expect(a[0].legislatorVotes).toEqual(b[0].legislatorVotes)
    expect([count(a[0], 'yes'), count(a[0], 'no')]).toEqual([count(b[0], 'yes'), count(b[0], 'no')])
    const rows = await rollCallRows()
    expect(rows.map(r => r.billId).sort()).toEqual([await billId('HB43'), await billId('HB837')].sort())
    expect(new Set(rows.map(r => r.rollCallId)).size).toBe(2)
    expect((await voteRows())).toHaveLength(2 * houseRoll(await rollText(HB43)).members.length)
  })

  it('is fetched once for the bills of one ingest even when a Senate and a House roll call are mixed in', async () => {
    linkSecondBill()
    await ingest('HB43', 'HJR35', 'HB837', 'HJR140')
    for (const url of [HB43, HJR35.house, HJR35.senate, HJR140.house, ...HJR140.senate]) expect(calls.filter(u => u === url), url).toHaveLength(1)
  })

  it('is served once on a bill whose actions link it more than once, as the House floor and the Library of Congress both do', async () => {
    await ingest('HB43')
    expect(xml('hr43').match(new RegExp(`<url>${HB43.replace(/\./g, '\\.')}</url>`, 'g'))).toHaveLength(2)
    await rollsOf('HB43', 1)
    expect(await rollCallRows()).toHaveLength(1)
    expect(calls.filter(u => u === HB43)).toHaveLength(1)
  })

  it('has distinct ids for its different roll calls on one bill', async () => {
    await ingest('HR580')
    const ids = (await rollsOf('HR580', 4)).map((v: any) => v.id)
    expect(new Set(ids).size).toBe(4)
  })
})

describe('re-ingest', () => {
  it('changes nothing: the same roll call ids, rows, and people, and no row twice', async () => {
    await ingest('HJR35', 'HR580')
    const before = { rolls: await rollCallRows(), votes: await voteRows(), people: await db().select().from(schema.people).all(), api: await bill('HJR35') }
    expect(before.rolls).toHaveLength(6)
    await ingest('HJR35', 'HR580')
    expect(await rollCallRows()).toEqual(before.rolls)
    expect((await voteRows()).sort((a, b) => a.id.localeCompare(b.id))).toEqual([...before.votes].sort((a, b) => a.id.localeCompare(b.id)))
    expect(await db().select().from(schema.people).all()).toEqual(before.people)
    expect(await bill('HJR35')).toEqual(before.api)
  })

  it('mints each roll call\'s id once: a later ingest finds the id it had', async () => {
    await ingest('HJR35')
    const before = (await db().select().from(schema.providerIds).all()).filter(r => r.kind === 'rollcall')
    expect(before).toHaveLength(2)
    await ingest('HJR35')
    expect((await db().select().from(schema.providerIds).all()).filter(r => r.kind === 'rollcall')).toEqual(before)
  })

  it('logs a roll call as a new vote once, when a bill\'s file first gains it, and not again on a re-ingest', async () => {
    await ingest('HJR35')
    const log = () => db().select().from(schema.billChangeLog).where(eq(schema.billChangeLog.billId, billIdHJR35)).all()
    const billIdHJR35 = await billId('HJR35')
    const added = async () => (await log()).filter(c => c.changeType === 'vote_added')
    const baseline = (await added()).length
    await ingest('HJR35')
    expect(await added()).toHaveLength(baseline)
    edit('hjres35', x => x.replace(/<actions>/, `<actions>
      <item>
        <actionDate>2025-03-05</actionDate>
        <text>On motion to table Agreed to by the Yeas and Nays.</text>
        <type>Floor</type>
        <sourceSystem><code>2</code><name>House floor actions</name></sourceSystem>
        <recordedVotes><recordedVote><rollNumber>195</rollNumber><url>${HR580[1]}</url><chamber>House</chamber><congress>119</congress><date>2025-06-25T20:35:00Z</date><sessionNumber>1</sessionNumber></recordedVote></recordedVotes>
      </item>`))
    await ingest('HJR35')
    const now = await added()
    expect(now).toHaveLength(baseline + 1)
    expect(now.at(-1)).toMatchObject({ detail: 'On Agreeing to the Resolution' })
    await ingest('HJR35')
    expect(await added()).toHaveLength(baseline + 1)
  })

  it('replaces a member vote a roll call file has since corrected, instead of adding another beside it', async () => {
    await ingest('HJR35')
    const before = await voteRows()
    expect(before.length, 'the first ingest writes the member votes').toBeGreaterThan(0)
    await editRoll(HJR35.senate, x => x.replace(/(<last_name>Alsobrooks<\/last_name>[\s\S]*?<vote_cast>)Nay(<\/vote_cast>)/, '$1Yea$2'))
    // A later ingest, once the roll call has had time to change.
    vi.setSystemTime(new Date('2026-09-28T10:00:00Z'))
    await ingest('HJR35')
    const after = await voteRows()
    expect(after).toHaveLength(before.length)
    const bio = await bioguideOf()
    const person = [...bio].find(([, b]) => b === 'A000382')![0]
    expect(after.find(r => String(r.peopleId) === person && r.voteText === 'Yea')).toBeTruthy()
    expect(before.find(r => String(r.peopleId) === person)?.voteText).toBe('Nay')
  })

  it('drops a roll call the bill\'s file no longer links, with its member votes', async () => {
    await ingest('HR580')
    expect(await rollCallRows()).toHaveLength(4)
    edit('hres580', x => x.replace(/<recordedVotes>\s*<recordedVote>\s*<rollNumber>198<\/rollNumber>[\s\S]*?<\/recordedVotes>/g, ''))
    await ingest('HR580')
    const rows = await rollCallRows()
    expect(rows).toHaveLength(3)
    const left = await voteRows()
    expect(left.every(v => rows.some(r => r.rollCallId === v.rollCallId))).toBe(true)
  })
})

describe('the hash rule', () => {
  it('changes a bill\'s record hash when a recorded vote is added to its file, and the next ingest adds the roll call', async () => {
    await ingest('HB3132')
    expect((await bill('HB3132')).votes).toEqual([])
    const hash = async () => (await db().select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, await billId('HB3132'))).get())!.rawHash
    const before = await hash()
    edit('hr3132', x => x.replace(/<actions>/, `<actions>
      <item>
        <actionDate>2025-02-04</actionDate>
        <text>On motion to suspend the rules and pass the bill Agreed to by the Yeas and Nays.</text>
        <type>Floor</type>
        <sourceSystem><code>2</code><name>House floor actions</name></sourceSystem>
        <recordedVotes>
          <recordedVote>
            <rollNumber>28</rollNumber>
            <url>${HB43}</url>
            <chamber>House</chamber>
            <congress>119</congress>
            <date>2025-02-04T23:58:50Z</date>
            <sessionNumber>1</sessionNumber>
          </recordedVote>
        </recordedVotes>
      </item>`))
    // The instance tracks this bill, so the sync queues its ingest.
    const { run } = await syncAndIngest()
    expect(await hash()).not.toBe(before)
    expect(queuedIds(run)).toEqual([await billId('HB3132')])
    expect(await rollsOf('HB3132', 1)).toHaveLength(1)
  })

  it('leaves a bill alone when only the file\'s updateDate moves, roll calls and all', async () => {
    await ingest('HJR35')
    await rollsOf('HJR35', 2)
    const run = makeRun()
    edit('hjres35', x => x.replace(/(<updateDate>)[^<]*(<\/updateDate>)/g, '$12026-10-18T05:00:00Z$2'))
    await sync(run)
    expect(queuedIds(run)).toEqual([])
  })
})

describe('what a recorded vote links', () => {
  const link = (url: string, over: Partial<Record<string, string>> = {}) => `<actions>
      <item>
        <actionDate>2025-03-05</actionDate>
        <text>A vote.</text>
        <type>Floor</type>
        <sourceSystem><code>2</code><name>House floor actions</name></sourceSystem>
        <recordedVotes>
          <recordedVote>
            <rollNumber>${over.roll ?? '28'}</rollNumber>
            <url>${url}</url>
            <chamber>${over.chamber ?? 'House'}</chamber>
            <congress>${over.congress ?? '119'}</congress>
            <date>2025-02-04T23:58:50Z</date>
            <sessionNumber>${over.session ?? '1'}</sessionNumber>
          </recordedVote>
        </recordedVotes>
      </item>`

  it.each([
    ['an address on another host', 'https://example.com/evs/2025/roll028.xml', {}],
    ['an address that is the Clerk\'s on another scheme', 'http://clerk.house.gov/evs/2025/roll028.xml', {}],
    ['an address with a path that isn\'t a roll call file', 'https://clerk.house.gov/evs/2025/roll028.xml/../../secret.xml', {}],
    ['an address that is the Clerk\'s with a query string added', 'https://clerk.house.gov/evs/2025/roll028.xml?x=1', {}],
    ['a Clerk address that is the Senate\'s chamber', houseUrl(2025, 28), { chamber: 'Senate' }],
    ['a Senate address that is the House\'s chamber', senateUrl(119, 1, 97), { chamber: 'House', roll: '97' }],
    ['a roll number that isn\'t the address\'s', houseUrl(2025, 28), { roll: '29' }],
    ['a roll number that isn\'t a number', houseUrl(2025, 28), { roll: 'twenty-eight' }],
    ['a Congress that isn\'t this one', houseUrl(2025, 28), { congress: '118' }],
    ['a session that isn\'t the address\'s year', houseUrl(2025, 28), { session: '2' }],
    ['a session that isn\'t 1 or 2', houseUrl(2025, 28), { session: '3' }],
    ['a Senate address of another Congress', senateUrl(118, 1, 97), { chamber: 'Senate', roll: '97', congress: '118' }],
  ])('fails closed on %s, and never asks for it', async (_what, url, over) => {
    edit('hr43', x => x.replace(/<actions>/, link(url, over as any)))
    const before = calls.length
    await ingestFailing('HB43')
    await nothingWritten()
    expect(calls.slice(before).filter(u => u.includes('example.com') || u.includes('secret.xml') || u.startsWith('http://') || u.includes('?x=1'))).toEqual([])
  })

  it('fails closed on a recorded vote with no address', async () => {
    edit('hr43', x => x.replace(/<actions>/, link('').replace('<url></url>', '')))
    await ingestFailing('HB43')
    await nothingWritten()
  })
})

describe('failing closed', () => {
  const answers: [string, () => Response][] = [
    ['HTTP 404', () => new Response('not found', { status: 404 })],
    ['HTTP 500', () => new Response('error', { status: 500 })],
    ['HTTP 429', () => new Response('slow down', { status: 429 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['a web page', () => new Response('<html><body>Service unavailable</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['text that isn\'t XML', () => new Response('this is not a vote', { status: 200 })],
    ['bytes that aren\'t UTF-8', () => new Response(new Uint8Array([0x3c, 0x62, 0xff, 0xfe, 0x3e]), { status: 200 })],
    ['a redirect with no body', () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })],
  ]

  it.each(answers)('writes nothing and retries when the House Clerk answers %s', async (_what, answer) => {
    served.set(HJR35.house, answer)
    await ingestFailing('HJR35')
    await nothingWritten()
  })

  it.each(answers)('writes nothing and retries when the Senate answers %s', async (_what, answer) => {
    served.set(HJR35.senate, answer)
    await ingestFailing('HJR35')
    await nothingWritten()
  })

  it('writes nothing and retries when a roll call file is cut off in the middle', async () => {
    const whole = await rollText(HJR35.house)
    served.set(HJR35.house, () => new Response(whole.slice(0, Math.floor(whole.length / 2)), { status: 200 }))
    await ingestFailing('HJR35')
    await nothingWritten()
    const senate = await rollText(HJR35.senate)
    served.set(HJR35.house, () => new Response(whole, { status: 200 }))
    served.set(HJR35.senate, () => new Response(senate.slice(0, Math.floor(senate.length / 2)), { status: 200 }))
    await ingestFailing('HJR35')
    await nothingWritten()
  })

  it('writes nothing and retries when the network fails outright', async () => {
    served.set(HJR35.senate, () => { throw new TypeError('network connection lost') })
    await ingestFailing('HJR35')
    await nothingWritten()
  })

  it.each([
    ['a House roll call of another roll number', HJR35.house, (x: string) => x.replace('<rollcall-num>52</rollcall-num>', '<rollcall-num>53</rollcall-num>')],
    ['a House roll call of another Congress', HJR35.house, (x: string) => x.replace('<congress>119</congress>', '<congress>118</congress>')],
    ['a House roll call of another session', HJR35.house, (x: string) => x.replace('<session>1st</session>', '<session>2nd</session>')],
    ['a House roll call with an unknown vote', HJR35.house, (x: string) => x.replace('<vote>Yea</vote>', '<vote>Maybe</vote>')],
    ['a House roll call with a vote for a candidate', HJR35.house, (x: string) => x.replace('<vote>Yea</vote>', '<vote>Jeffries</vote>')],
    ['a House roll call with an unknown result', HJR35.house, (x: string) => x.replace('<vote-result>Passed</vote-result>', '<vote-result>Tabled forever</vote-result>')],
    ['a House roll call with no result', HJR35.house, (x: string) => x.replace('<vote-result>Passed</vote-result>', '')],
    ['a House roll call with no question', HJR35.house, (x: string) => x.replace(/<vote-question>[^<]*<\/vote-question>/, '')],
    ['a House roll call with no date', HJR35.house, (x: string) => x.replace(/<action-date>[^<]*<\/action-date>/, '')],
    ['a House roll call with a date that isn\'t one', HJR35.house, (x: string) => x.replace(/<action-date>[^<]*<\/action-date>/, '<action-date>last week</action-date>')],
    ['a House roll call with no totals', HJR35.house, (x: string) => x.replace(/<totals-by-vote>[\s\S]*?<\/totals-by-vote>/, '')],
    ['a House roll call with a total that isn\'t a number', HJR35.house, (x: string) => x.replace(/(<totals-by-vote>[\s\S]*?<yea-total>)\d+/, '$1many')],
    ['a House roll call with a negative total', HJR35.house, (x: string) => x.replace(/(<totals-by-vote>[\s\S]*?<yea-total>)\d+/, '$1-4')],
    ['a House roll call with no votes', HJR35.house, (x: string) => x.replace(/<vote-data>[\s\S]*<\/vote-data>/, '<vote-data></vote-data>')],
    ['a House roll call with no vote-data', HJR35.house, (x: string) => x.replace(/<vote-data>[\s\S]*<\/vote-data>/, '')],
    ['a House voter with no Bioguide id', HJR35.house, (x: string) => x.replace('name-id="A000370"', 'name-id=""')],
    ['a House voter with an id that isn\'t a Bioguide id', HJR35.house, (x: string) => x.replace('name-id="A000370"', 'name-id="not-an-id"')],
    ['a House voter with no name-id at all', HJR35.house, (x: string) => x.replace('name-id="A000370" ', '')],
    ['a House voter listed twice', HJR35.house, (x: string) => x.replace('name-id="A000370"', 'name-id="B001281"')],
    ['a House voter with no vote', HJR35.house, (x: string) => x.replace(/<vote>Yea<\/vote>/, '<vote></vote>')],
    ['a House voter with no name', HJR35.house, (x: string) => x.replace('>Adams</legislator>', '></legislator>')],
    ['a House file that is a Senate roll call', HJR35.house, () => '<roll_call_vote><congress>119</congress></roll_call_vote>'],
    ['a Senate roll call of another vote number', HJR35.senate, (x: string) => x.replace('<vote_number>97</vote_number>', '<vote_number>98</vote_number>')],
    ['a Senate roll call of another Congress', HJR35.senate, (x: string) => x.replace('<congress>119</congress>', '<congress>118</congress>')],
    ['a Senate roll call of another session', HJR35.senate, (x: string) => x.replace('<session>1</session>', '<session>2</session>')],
    ['a Senate roll call with an unknown vote', HJR35.senate, (x: string) => x.replace('<vote_cast>Yea</vote_cast>', '<vote_cast>Maybe</vote_cast>')],
    ['a Senate roll call with a vote that is a verdict', HJR35.senate, (x: string) => x.replace('<vote_cast>Yea</vote_cast>', '<vote_cast>Guilty</vote_cast>')],
    ['a Senate roll call with an unknown result', HJR35.senate, (x: string) => x.replace('<vote_result>Joint Resolution Passed</vote_result>', '<vote_result>Considered</vote_result>')],
    ['a Senate roll call with no result', HJR35.senate, (x: string) => x.replace('<vote_result>Joint Resolution Passed</vote_result>', '')],
    ['a Senate roll call with no question', HJR35.senate, (x: string) => x.replace(/<vote_question_text>[^<]*<\/vote_question_text>/, '').replace(/<question>[^<]*<\/question>/, '')],
    ['a Senate roll call with no date', HJR35.senate, (x: string) => x.replace(/<vote_date>[^<]*<\/vote_date>/, '')],
    ['a Senate roll call with a date that isn\'t one', HJR35.senate, (x: string) => x.replace(/<vote_date>[^<]*<\/vote_date>/, '<vote_date>some Tuesday</vote_date>')],
    ['a Senate roll call with no count', HJR35.senate, (x: string) => x.replace(/<count>[\s\S]*?<\/count>/, '')],
    ['a Senate roll call with a count that isn\'t a number', HJR35.senate, (x: string) => x.replace('<yeas>52</yeas>', '<yeas>lots</yeas>')],
    ['a Senate roll call with a negative count', HJR35.senate, (x: string) => x.replace('<yeas>52</yeas>', '<yeas>-1</yeas>')],
    ['a Senate roll call with no members', HJR35.senate, (x: string) => x.replace(/<members>[\s\S]*<\/members>/, '<members></members>')],
    ['a Senate roll call with no members element', HJR35.senate, (x: string) => x.replace(/<members>[\s\S]*<\/members>/, '')],
    ['a Senate member with no LIS id', HJR35.senate, (x: string) => x.replace('<lis_member_id>S428</lis_member_id>', '')],
    ['a Senate member with an id that isn\'t a LIS id', HJR35.senate, (x: string) => x.replace('<lis_member_id>S428</lis_member_id>', '<lis_member_id>Alsobrooks</lis_member_id>')],
    ['a Senate member listed twice', HJR35.senate, (x: string) => x.replace('<lis_member_id>S428</lis_member_id>', '<lis_member_id>S330</lis_member_id>')],
    ['a Senate member with no vote', HJR35.senate, (x: string) => x.replace(/<vote_cast>Nay<\/vote_cast>/, '<vote_cast></vote_cast>')],
    ['a Senate member with no last name', HJR35.senate, (x: string) => x.replace('<last_name>Alsobrooks</last_name>', '<last_name></last_name>')],
    ['a Senate file that is a House roll call', HJR35.senate, () => '<rollcall-vote><vote-metadata></vote-metadata></rollcall-vote>'],
  ])('writes nothing and retries on %s', async (_what, url, change) => {
    await editRoll(url, change)
    await ingestFailing('HJR35')
    await nothingWritten()
  })

  it('keeps what an earlier ingest stored when a later one fails, and says nothing to instances', async () => {
    await ingest('HJR35')
    const before = await bill('HJR35')
    const stored = { rolls: await rollCallRows(), votes: await voteRows() }
    vi.setSystemTime(new Date('2026-09-28T10:00:00Z'))
    served.set(HJR35.senate, () => new Response('error', { status: 500 }))
    const run = makeRun()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const messages = await seam.ingest(await billId('HJR35'), run)
    expect(errors).toHaveBeenCalled()
    expect(messages[0].retry).toHaveBeenCalled()
    expect(await bill('HJR35')).toEqual(before)
    expect(await rollCallRows()).toEqual(stored.rolls)
    expect(await voteRows()).toEqual(stored.votes)
    expect(seam.sentToTenant(run)).toEqual([])
  })

  it('mints no id for a roll call it could not read', async () => {
    served.set(HJR35.senate, () => new Response('error', { status: 500 }))
    await ingestFailing('HJR35')
    const minted = await db().select().from(schema.providerIds).all()
    expect(minted.filter(m => ['person', 'rollcall', 'doc', 'committee', 'subject'].includes(m.kind))).toEqual([])
  })

  it('reads the next bill after one fails: a bad roll call holds back that bill alone', async () => {
    served.set(HJR35.house, () => new Response('error', { status: 500 }))
    await sync()
    const messages = await seam.ingest([await billId('HB43'), await billId('HJR35'), await billId('HR580')])
    expect(messages.map(m => m.retry.mock.calls.length)).toEqual([0, 1, 0])
    expect((await bill('HB43')).votes).toHaveLength(1)
    expect((await bill('HR580')).votes).toHaveLength(4)
    expect((await bill('HJR35')).votes).toEqual([])
  })

  it('doesn\'t keep a failed answer: the next ingest asks again and succeeds', async () => {
    served.set(HJR35.house, () => new Response('error', { status: 500 }))
    await ingestFailing('HJR35')
    served.set(HJR35.house, () => new Response(rollCallFiles.get('house-2025-roll052.xml')!, { status: 200 }))
    await ingest('HJR35')
    expect((await bill('HJR35')).votes).toHaveLength(2)
  })
})

describe('every recorded bill that links a vote', () => {
  it('ingests, with a roll call for each distinct vote its actions link', async () => {
    await sync()
    const linked = [...files].filter(([, x]) => x.includes('<recordedVote>'))
    expect(linked.length).toBeGreaterThanOrEqual(7)
    const prefix: Record<string, string> = { hr: 'HB', s: 'SB', hres: 'HR', sres: 'SR', hjres: 'HJR', sjres: 'SJR', hconres: 'HCR', sconres: 'SCR' }
    const numbers = linked.map(([name]) => {
      const m = /^BILLSTATUS-119([a-z]+)(\d+)\.xml$/.exec(name)!
      return `${prefix[m[1]]}${m[2]}`
    })
    const messages = await seam.ingest(await Promise.all(numbers.map(billId)))
    for (const m of messages) expect(m.retry, JSON.stringify(m.body)).not.toHaveBeenCalled()
    for (const [i, [, x]] of linked.entries()) {
      // The bill's own actions, not its amendments' (which the provider leaves out).
      const actions = /<actions>[\s\S]*?<\/actions>/.exec(x.replace(/<amendments>[\s\S]*?<\/amendments>/, ''))![0]
      const distinct = new Set([...actions.matchAll(/<url>(https:\/\/(?:clerk\.house\.gov|www\.senate\.gov)[^<]*)<\/url>/g)].map(m => m[1]))
      expect((await bill(numbers[i])).votes, numbers[i]).toHaveLength(distinct.size)
    }
  })

  it('is not asked for any file the recorded bills don\'t link', async () => {
    await sync()
    await seam.ingest(await Promise.all(['HB43', 'HJR35'].map(billId)))
    const asked = calls.filter(isRollCallHost)
    expect(asked.length).toBeGreaterThan(0)
    for (const url of asked) expect([HB43, HJR35.house, HJR35.senate, CVC_URL, HISTORICAL_URL], url).toContain(url)
  })
})
