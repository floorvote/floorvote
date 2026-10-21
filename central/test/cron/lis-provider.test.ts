import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import s2026Raw from '../fixtures/lis/20261-sample.json?raw'
import s2027Raw from '../fixtures/lis/20271-sample.json?raw'

// Virginia from the LIS public data files at the main seam (#301): the
// recorded files in, with the network stubbed at fetch, and central's bill
// API, its labels, and the notifications queued for tenants out.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { lis } from '../../src/providers/lis'
import { LIS_FILES, LIS_FILES_BASE, type LisFile, type LisFiles } from '../../src/providers/lis/client'
import { toLegacyHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral } from '../helpers/mainSeam'

const s2026 = () => JSON.parse(s2026Raw) as LisFiles
const s2027 = () => JSON.parse(s2027Raw) as LisFiles

/** One served file: its body, ETag, and any headers a test adds. Null is a 404. */
type Served = { text: string; etag: string; headers?: Record<string, string>; status?: number } | null
/** What the stubbed LIS serves, by session code and file. A session left out is a 404 for every file. */
let sessions: Record<string, Partial<Record<LisFile, Served>>>
/** Every request: method, session, and file. */
let calls: { method: string; code: string; file: LisFile | undefined }[]

/** Serve a session's files, each with an ETag of its own. An empty fixture file is one the session doesn't publish. */
function serve(code: string, files: LisFiles, version = 'v1') {
  sessions[code] = Object.fromEntries((Object.keys(LIS_FILES) as LisFile[]).map(file =>
    [file, files[file] ? { text: files[file], etag: `"${code}-${file}-${version}"` } : null]))
}

const seam = mainSeam(lis, { tenantId: 'vateam' })
const { makeRun, queued, queuedIds, sentToTenant, central, getJson, sync, syncAndIngest, ingest } = seam
const gets = (code = '20261') => calls.filter(c => c.method === 'GET' && c.code === code).map(c => c.file)
const heads = (code = '20261') => calls.filter(c => c.method === 'HEAD' && c.code === code).map(c => c.file)
const claim = (provider: string) => seam.claim('VA', provider)
/** The central id of a bill by number, in a session (by its tag). */
const billId = (number: string, code = '20261') => seam.billIdOf(number, code)

/** Every bill of a provider's, sorted: it declares ingestAll (#835), so a pass queues each one. */
async function allBills(provider: string): Promise<number[]> {
  const rows = await env.DB.prepare('SELECT bill_id FROM bills WHERE provider = ? ORDER BY bill_id').bind(provider).all<{ bill_id: number }>()
  return rows.results.map(r => r.bill_id)
}

beforeEach(async () => {
  await resetCentral()
  sessions = {}
  serve('20261', s2026())
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    if (!url.startsWith(`${LIS_FILES_BASE}/`)) throw new Error(`no network in this test: ${method} ${url}`)
    const [code, name] = url.slice(LIS_FILES_BASE.length + 1).split('/')
    const file = (Object.keys(LIS_FILES) as LisFile[]).find(f => LIS_FILES[f] === name)
    calls.push({ method, code, file })
    const served = file ? sessions[code]?.[file] : null
    if (!served) return new Response('<Error><Code>BlobNotFound</Code></Error>', { status: 404 })
    const headers = { ETag: served.etag, ...served.headers }
    if (served.status) return new Response('server error', { status: served.status })
    return new Response(method === 'HEAD' ? null : served.text, { headers })
  })
  await seam.addTenant('VA', ['minimum wage', 'daylight', 'procurement'])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Virginia from the LIS data files', () => {
  it('stays on LegiScan until Virginia is claimed', async () => {
    expect(await sync(makeRun())).toEqual([])
    expect(calls).toEqual([])
  })

  it('syncs Virginia once claimed, with no key, no LegiScan call, and per-member votes', async () => {
    expect((await claim('lis')).status).toBe(200)
    const { run } = await syncAndIngest()
    expect(queuedIds(run).sort()).toEqual(await allBills('lis'))

    const bill = await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)
    expect(bill).toMatchObject({
      number: 'HB1', state: 'VA', status: 'Approved by the Governor', statusStage: 'enacted', statusRank: 702, billType: 'B',
      stateUrl: 'https://lis.virginia.gov/bill-details/20261/HB1', texts: [],
    })
    // The latest summary is the description, as plain text.
    expect(bill.abstract).toMatch(/^Minimum wage\. Increases the minimum wage/)
    expect(bill.abstract).not.toMatch(/[<>]/)
    expect(bill.sponsors[0]).toMatchObject({ name: 'Jeion A. Ward', primary: true })

    // Every member's vote, named, on the floor vote.
    const count = (v: any, o: string) => v.counts.find((c: any) => c.option === o)?.value
    const floor = bill.votes.find((v: any) => count(v, 'yes') === 64 && count(v, 'no') === 34)
    expect(floor.legislatorVotes).toHaveLength(100)
    expect(floor.legislatorVotes).toContainEqual(expect.objectContaining({ name: 'Jeion A. Ward', vote: 'Yea' }))
    expect(floor.legislatorVotes.every((v: any) => v.name !== v.personId)).toBe(true)

    // Fiscal impact statements are supplements.
    expect(bill.supplements.length).toBeGreaterThan(0)
    expect(bill.supplements.every((s: any) => s.type === 'Fiscal Note' && /^https:\/\/lis\.blob\.core\.windows\.net\/files\/\d+\.PDF$/.test(s.stateLink))).toBe(true)

    // Extras under the provider's name: the chapter, and the earlier summary.
    expect(bill.extras.providerName).toBe('Virginia General Assembly')
    expect(bill.extras.fields.map((f: any) => [f.key, f.label])).toEqual([
      ['chapter', 'Chapter'], ['summaryIntroduced', 'Summary as introduced'],
    ])
    expect(bill.extras.fields[0].value).toBe('Chapter 350 of the 2026 Acts of Assembly')
    expect(bill.extras.fields[1].value).toMatch(/^Minimum wage\./)

    // Referrals point at committees rows, one per chamber and name.
    expect(bill.referrals[0]).toMatchObject({ name: 'Labor and Commerce', chamber: 'H' })
    expect(Number(bill.referrals[0].committeeId)).toBeGreaterThan(3_000_000_000)
    const db = drizzle(env.DB, { schema })
    const committee = await db.select().from(schema.committees).where(eq(schema.committees.committeeId, Number(bill.referrals[0].committeeId))).get()
    expect(committee).toMatchObject({ provider: 'lis', state: 'VA', name: 'Labor and Commerce', chamber: 'H' })

    expect(calls.length).toBeGreaterThan(0)
    const full = sentToTenant(run).filter((m: any) => !m.stubOnly).map((m: any) => m.billId)
    expect(full).toEqual(expect.arrayContaining([toLegacyHandle(await billId('HB1')), toLegacyHandle(await billId('HB61'))]))
  })

  it('maps every bill to a bill type and status Virginia\'s labels list', async () => {
    await claim('lis')
    await syncAndIngest()
    const all = await drizzle(env.DB, { schema }).select({ id: schema.bills.billId }).from(schema.bills).all()
    for (const m of await ingest(all.map(r => r.id))) expect(m.retry).not.toHaveBeenCalled()

    const labels = await getJson('/bills/labels?state=VA')
    const types = new Set(labels.billTypes.map((t: any) => t.value.toLowerCase()))
    const statuses = new Set(labels.statuses.map((s: any) => s.label))
    const seen = []
    for (const number of ['HB1', 'HB9', 'HB61', 'HB133', 'HB447', 'HR1']) {
      const bill = await getJson(`/bills/${toLegacyHandle(await billId(number))}`)
      expect(types.has(String(bill.billType).toLowerCase()), `${number}: ${bill.billType}`).toBe(true)
      expect(statuses.has(bill.status), `${number}: ${bill.status}`).toBe(true)
      seen.push(bill.status)
    }
    expect(seen).toEqual(['Approved by the Governor', 'Continued to next session', 'Vetoed by the Governor', 'Failed', 'Continued to next session', 'Agreed to'])
  })
})

describe('Virginia votes and committees', () => {
  const countOf = (v: any, option: string) => v.counts.find((c: any) => c.option === option)?.value
  const votesOf = async (number: string) => (await getJson(`/bills/${toLegacyHandle(await billId(number))}`)).votes as any[]
  const replaceOnce = (text: string, from: string, to: string) => {
    expect(text).toContain(from)
    return text.replace(from, to)
  }
  /** A voice vote on the Senate floor, as the files record one: every member "X", and a history line with no count. */
  function withVoiceVotes(bills: string[], refid = 'VSV1094') {
    const files = s2026()
    const counted = files.votes.split('\n').find(l => l.startsWith('"SV866"'))!
    files.votes += `${counted.replace(/"[YNA]"/g, '"X"').replace('"SV866"', `"${refid}"`)}\n`
    files.history += bills.map(b => `"${b}","3/3/2026","S Passed by for the day  Block Vote (Voice Vote)","${refid}"\n`).join('')
    return files
  }

  it('gives every bill on a block vote the vote, not only the last bill ingested', async () => {
    await claim('lis')
    await syncAndIngest()
    // HB 1 and HB 61 are both on the Senate's constitutional reading vote (SV866), 40 to 0.
    const [hb1, hb61] = [await votesOf('HB1'), await votesOf('HB61')]
    const shared = (votes: any[]) => votes.filter(v => countOf(v, 'yes') === 40 && countOf(v, 'no') === 0)
    expect(shared(hb1)).toHaveLength(1)
    expect(shared(hb61)).toHaveLength(1)
    expect(shared(hb1)[0].legislatorVotes).toHaveLength(40)
    expect(shared(hb61)[0].legislatorVotes).toHaveLength(40)
    // Two bills, two roll calls, each with its own id.
    expect(shared(hb1)[0].id).not.toBe(shared(hb61)[0].id)
    // Every counted vote in each bill's history is a roll call on it: no bill lost a vote to another.
    const db = drizzle(env.DB, { schema })
    for (const [number, votes] of [['HB1', hb1], ['HB61', hb61]] as const) {
      const rows = await db.select().from(schema.rollCalls).where(eq(schema.rollCalls.billId, await billId(number))).all()
      expect(rows.map(r => String(r.rollCallId)).sort()).toEqual(votes.map(v => v.id).sort())
    }
    // HB 1's history names 7 counted votes, HB 61's 12, and each bill has all of them.
    expect(hb1).toHaveLength(7)
    expect(hb61).toHaveLength(12)
  })

  it('keeps a bill\'s roll call ids the same on every ingest', async () => {
    await claim('lis')
    await syncAndIngest()
    const before = (await votesOf('HB1')).map(v => v.id).sort()
    await ingest(await billId('HB1'))
    expect((await votesOf('HB1')).map(v => v.id).sort()).toEqual(before)
  })

  it('leaves a voice vote out, rather than showing a 0-0 vote that failed', async () => {
    serve('20261', withVoiceVotes(['HB1', 'HB61']))
    await claim('lis')
    await syncAndIngest()
    for (const number of ['HB1', 'HB61']) {
      const votes = await votesOf(number)
      expect(votes.some(v => /Block Vote \(Voice Vote\)/.test(v.motionText)), number).toBe(false)
      expect(votes.every(v => countOf(v, 'yes') + countOf(v, 'no') > 0 && v.legislatorVotes.length > 0), number).toBe(true)
      expect(votes.every(v => v.legislatorVotes.every((l: any) => l.vote !== 'Not Voting' || countOf(v, 'yes') > 0)), number).toBe(true)
      // The history still says it happened.
      const bill = await getJson(`/bills/${toLegacyHandle(await billId(number))}`)
      expect(bill.actions.map((a: any) => a.description)).toContain('Passed by for the day  Block Vote (Voice Vote)')
    }
    const db = drizzle(env.DB, { schema })
    const memberRows = await db.select().from(schema.rollCallVotes).all()
    expect(memberRows.some(r => r.voteText === 'Not Voting' && memberRows.filter(m => m.rollCallId === r.rollCallId).every(m => m.voteText === 'Not Voting'))).toBe(false)
  })

  it('replaces a bill\'s roll calls on its next ingest, so rows the old mapping left don\'t stay beside the new ones', async () => {
    const files = withVoiceVotes(['HB1'])
    serve('20261', files)
    await claim('lis')
    await syncAndIngest()
    const hb1 = await billId('HB1')
    const db = drizzle(env.DB, { schema })
    const idsOf = async () => (await db.select({ id: schema.rollCalls.rollCallId }).from(schema.rollCalls).where(eq(schema.rollCalls.billId, hb1)).all()).map(r => r.id).sort()
    const expected = await idsOf()

    // The state a central that ingested HB 1 before the fix holds: the shared vote under an id from the
    // reference id alone, and the voice vote as a 0-0 roll call with every member "Not Voting".
    const OLD_SHARED = 3_900_000_001
    const OLD_VOICE = 3_900_000_002
    const shared = (await db.select().from(schema.rollCalls).where(eq(schema.rollCalls.billId, hb1)).all()).find(r => r.yea === 40)!
    await env.DB.batch([
      env.DB.prepare(`UPDATE roll_call_votes SET id = ? || '-' || people_id, roll_call_id = ? WHERE roll_call_id = ?`).bind(OLD_SHARED, OLD_SHARED, shared.rollCallId),
      env.DB.prepare(`UPDATE roll_calls SET roll_call_id = ? WHERE roll_call_id = ?`).bind(OLD_SHARED, shared.rollCallId),
      env.DB.prepare(`INSERT INTO roll_calls (roll_call_id, bill_id, date, description, yea, nay, nv, absent, total, passed, chamber)
        VALUES (?, ?, '2026-03-03', 'Passed by for the day  Block Vote (Voice Vote)', 0, 0, 40, 0, 40, 0, 'S')`).bind(OLD_VOICE, hb1),
      env.DB.prepare(`INSERT INTO roll_call_votes (id, roll_call_id, people_id, vote_id, vote_text)
        SELECT ? || '-' || people_id, ?, people_id, 3, 'Not Voting' FROM roll_call_votes WHERE roll_call_id = ?`).bind(OLD_VOICE, OLD_VOICE, OLD_SHARED),
      env.DB.prepare(`DELETE FROM bill_change_log WHERE bill_id = ?`).bind(hb1),
    ])
    expect(await idsOf()).toContain(OLD_VOICE)

    for (const m of await ingest(hb1)) expect(m.retry).not.toHaveBeenCalled()
    // The old rows and their member votes are gone, and the bill holds exactly the roll calls the mapping builds now.
    expect(await idsOf()).toEqual(expected)
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM roll_call_votes WHERE roll_call_id IN (?, ?)`).bind(OLD_SHARED, OLD_VOICE).first<{ n: number }>()
    expect(left!.n).toBe(0)
    const orphans = await env.DB.prepare(`SELECT COUNT(*) AS n FROM roll_call_votes WHERE roll_call_id NOT IN (SELECT roll_call_id FROM roll_calls)`).first<{ n: number }>()
    expect(orphans!.n).toBe(0)
    // Instances aren't told of a "new" vote for each old one the ingest only re-keyed.
    const log = await db.select().from(schema.billChangeLog).where(eq(schema.billChangeLog.billId, hb1)).all()
    expect(log.filter(c => c.changeType === 'vote_added')).toEqual([])
  })

  it('sets the committee a bill waits in, and keeps a bill\'s re-referrals', async () => {
    // HB 1 as it stood on February 23: passed the House, reported from a Senate committee and rereferred to another.
    const files = s2026()
    files.history = files.history.split('\n').filter(line => {
      const m = /^"HB1","(\d+)\/(\d+)\/(\d{4})"/.exec(line)
      return !m || Number(m[3]) * 10000 + Number(m[1]) * 100 + Number(m[2]) <= 20260223
    }).join('\n')
    files.bills = replaceOnce(files.bills, '"N","Y","Y","Y","N","N","Y","N","HB1"', '"N","Y","N","N","N","N","N","N","HB1"')
    // The chapter number is in the row twice, as the chapter and as the Acts of Assembly text.
    files.bills = files.bills.split('\n').map(line => (line.startsWith('"HB1",') ? line.replaceAll('"CHAP0350"', '""') : line)).join('\n')
    serve('20261', files)
    await claim('lis')
    await syncAndIngest()

    const bill = await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)
    expect(bill.status).toBe('Passed the House')
    expect(bill.committee).toMatchObject({ name: 'Finance and Appropriations', chamber: 'S' })
    expect(bill.referrals.map((r: any) => [r.chamber, r.name])).toEqual([
      ['H', 'Labor and Commerce'], ['H', 'Appropriations'], ['S', 'Commerce and Labor'], ['S', 'Finance and Appropriations'],
    ])
    // The pending committee is the committee of the last referral, one committees row.
    expect(bill.committee.committeeId).toBe(bill.referrals[3].committeeId)
    // A bill that is done with committees (HB 61 passed both chambers) waits in none.
    expect((await getJson(`/bills/${toLegacyHandle(await billId('HB61'))}`)).committee).toBeNull()
  })
})

describe('a carried-over bill', () => {
  it('is a new bill in its new session, linked to the one it continues', async () => {
    serve('20271', s2027())
    await claim('lis')
    await syncAndIngest()

    const old = await billId('HB9', '20261')
    const carried = await billId('HB9', '20271')
    expect(carried).not.toBe(old)
    const bill = await getJson(`/bills/${toLegacyHandle(carried)}`)
    expect(bill).toMatchObject({ status: 'Continued from last session', statusStage: 'in_committee' })
    expect(bill.relatedBills).toEqual([expect.objectContaining({ identifier: 'HB9', sastBillId: old, relationType: 'carry-over' })])
    expect(await getJson(`/bills/${toLegacyHandle(old)}`)).toMatchObject({ status: 'Continued to next session', relatedBills: [] })
  })

  it('links nothing when central never synced the session it came from, and mints no id for it', async () => {
    sessions = {}
    serve('20271', s2027())
    await claim('lis')
    await syncAndIngest()

    const bill = await getJson(`/bills/${toLegacyHandle(await billId('HB9', '20271'))}`)
    expect(bill.relatedBills).toEqual([])
    const db = drizzle(env.DB, { schema })
    const keys = (await db.select().from(schema.providerIds).where(eq(schema.providerIds.kind, 'bill')).all()).map(r => r.nativeKey)
    expect(keys.sort()).toEqual(['20271/HB1532', '20271/HB9'])
  })

  it('syncs a session that has no votes, fiscal impact statements, or dockets yet', async () => {
    // 2027's prefile files: HB9's history holds 2026's votes and statements, which stay in 2026's files.
    sessions = {}
    serve('20271', s2027())
    await claim('lis')
    await syncAndIngest()
    expect(gets('20271').sort()).toEqual(Object.keys(LIS_FILES).sort())
    expect(await billId('HB1532', '20271')).toBeGreaterThan(3_000_000_000)
  })
})

describe('Virginia dockets on the calendar', () => {
  const calendarOf = (run: Run, handle: string) =>
    sentToTenant(run).filter((m: any) => m.billId === handle && m.calendar).map((m: any) => m.calendar)
  /** The 2026 files with more docket rows. */
  const withDockets = (rows: string) => { const f = s2026(); f.dockets += rows; return f }

  it('puts each committee docket on the calendar as a hearing', async () => {
    await claim('lis')
    await syncAndIngest()
    const bill = await getJson(`/bills/${toLegacyHandle(await billId('HB61'))}`)
    expect(bill.calendar.map((e: any) => [e.date, e.description, e.kind, e.type])).toEqual(expect.arrayContaining([
      ['2026-02-25', 'Senate General Laws and Technology docket', 'hearing', 'Hearing'],
      ['2026-03-03', 'Senate Finance and Appropriations docket', 'hearing', 'Hearing'],
    ]))
    const labels = await getJson('/bills/labels?state=VA')
    expect(labels.eventTypes).toEqual([expect.objectContaining({ typeId: 1, label: 'Hearing', kind: 'hearing' })])
  })

  it('gives one committee\'s dockets on two days identities of their own', async () => {
    serve('20261', withDockets('"S05","10/05/2026","1","HB61"\n"S05","10/12/2026","1","HB61"\n'))
    await claim('lis')
    const { run } = await syncAndIngest()
    const [cal] = calendarOf(run, toLegacyHandle(await billId('HB61')))
    const upcoming = cal.events.filter((e: any) => e.date >= '2026-10-01')
    expect(upcoming.map((e: any) => e.description)).toEqual(['Senate Finance and Appropriations docket', 'Senate Finance and Appropriations docket'])
    expect(new Set(upcoming.map((e: any) => e.identityKey)).size).toBe(2)
  })

  it('cancels a docket that leaves the files only after two successful pulls', async () => {
    serve('20261', withDockets('"S05","10/05/2026","1","HB61"\n'))
    await claim('lis')
    await syncAndIngest()
    const handle = toLegacyHandle(await billId('HB61'))
    const upcoming = async () => (await getJson(`/bills/${handle}`)).calendar.filter((e: any) => e.date === '2026-10-05')
    expect(await upcoming()).toHaveLength(1)

    // The docket comes off DOCKET.CSV: the next pull reads the change, and the entry stays.
    serve('20261', s2026(), 'v2')
    const first = await syncAndIngest()
    expect(await upcoming()).toHaveLength(1)
    expect(calendarOf(first.run, handle).flatMap((c: any) => c.changes).filter((ch: any) => ch.changeType === 'hearing_cancelled')).toEqual([])

    // The pull after that finds the files unchanged, which confirms it, and cancels the docket.
    calls = []
    const second = await syncAndIngest()
    expect(gets()).toEqual([])
    expect(await upcoming()).toEqual([])
    expect(calendarOf(second.run, handle).flatMap((c: any) => c.changes)).toEqual([
      expect.objectContaining({ changeType: 'hearing_cancelled', date: '2026-10-05' }),
    ])
  })
})

describe('failing closed', () => {
  /** A good pass, then the bill API's answer for HB1, to check a failed pass changes nothing. */
  async function firstPass() {
    await claim('lis')
    await syncAndIngest()
    return getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)
  }

  /**
   * A scheduled pass after the files changed (each gets a new ETag, so the
   * pass reads them all), which must fail without writing or sending anything.
   */
  async function failingPass(message: RegExp | string) {
    for (const served of Object.values(sessions['20261'])) if (served) served.etag = `${served.etag}+`
    const db = drizzle(env.DB, { schema })
    const recordsBefore = await db.select().from(schema.providerRecords).all()
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow(message)
    expect(queued(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
    expect(await db.select().from(schema.providerRecords).all()).toEqual(recordsBefore)
  }

  const required: LisFile[] = ['history', 'sponsors', 'summaries', 'members', 'committees']
  it.each(required)('fails when %s is missing, rather than rebuilding bills without it', async file => {
    const before = await firstPass()
    sessions['20261'][file] = null
    await failingPass(`LIS 20261: ${LIS_FILES[file]} is missing`)
    expect(await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)).toEqual(before)
  })

  it('fails on the first pass too, storing nothing', async () => {
    sessions['20261'].sponsors = null
    await claim('lis')
    await failingPass('Sponsors.csv is missing')
    expect(await drizzle(env.DB, { schema }).select().from(schema.bills).all()).toEqual([])
  })

  it('fails when votes are missing but this session\'s history records counted votes', async () => {
    await firstPass()
    sessions['20261'].votes = null
    await failingPass('VOTE.CSV is missing, though the last pass read it')
    // Even with no stored ETags to remember it by (after a claim), the history says it should be there.
    await drizzle(env.DB, { schema }).update(schema.sessions).set({ snapshotEtag: null })
    await failingPass('VOTE.CSV is missing, though this session\'s history records counted votes')
  })

  it('fails when fiscal impact statements are missing but the history records them', async () => {
    await claim('lis')
    sessions['20261'].fiscal = null
    await failingPass('FiscalImpactStatements.csv is missing, though this session\'s history records fiscal impact statements')
  })

  it('fails when a docket file the last pass read goes missing', async () => {
    await firstPass()
    sessions['20261'].dockets = null
    await failingPass('DOCKET.CSV is missing, though the last pass read it')
  })

  it('fails on an empty file the session must publish', async () => {
    await firstPass()
    sessions['20261'].history = { text: '', etag: '"empty"' }
    await failingPass('HISTORY.CSV is missing')
  })

  it('fails on a download shorter than its Content-Length', async () => {
    await firstPass()
    const votes = sessions['20261'].votes!
    votes.headers = { 'Content-Length': String(new TextEncoder().encode(votes.text).byteLength + 500) }
    await failingPass(/20261\/VOTE\.CSV: got \d+ bytes of \d+, so the file is truncated/)
  })

  it('fails on a file that stops mid-row', async () => {
    await firstPass()
    const history = sessions['20261'].history!
    history.text = history.text.slice(0, history.text.length - 20)
    await failingPass('20261/HISTORY.CSV: the file doesn\'t end with a line break, so it is truncated')
    // Cut mid-row but ending with a line break, the row is short a field.
    history.text = `${history.text.slice(0, history.text.lastIndexOf('","'))}"\n`
    await failingPass(/LIS 20261 history: line \d+ has \d fields, not the header's 4/)
  })

  it('fails on a quote that never closes, a renamed column, and an HTTP error', async () => {
    await firstPass()
    const sponsors = sessions['20261'].sponsors!
    const good = sponsors.text
    sponsors.text = `${good}"Jeion A. Ward","H0173","HB2","1 - Chief Patron\n`
    await failingPass(/LIS 20261 sponsors: a quote opened on line \d+ never closes/)
    sponsors.text = good.replace('"PATRON_TYPE"', '"PATRON_KIND"')
    await failingPass('LIS 20261 sponsors: the header has no PATRON_TYPE')
    sponsors.text = good
    sponsors.status = 503
    await failingPass('LIS HTTP 503 for 20261/Sponsors.csv')
  })
})

describe('files cut down to their header', () => {
  const header = (text: string) => text.slice(0, text.indexOf('\n') + 1)

  it.each(['history', 'sponsors', 'votes', 'fiscal'] as const)('fails on a header-only %s, rather than rebuilding every bill without it', async file => {
    await claim('lis')
    await syncAndIngest()
    const before = await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)
    const served = sessions['20261'][file]!
    served.text = header(served.text)
    served.etag = '"cut"'
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow(`LIS 20261 ${file}: no rows for`)
    expect(queued(run)).toEqual([])
    expect(await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)).toEqual(before)
  })

  it('fails on header-only dockets once the last pass found bills on them, so no docket is cancelled', async () => {
    await claim('lis')
    await syncAndIngest()
    const dockets = sessions['20261'].dockets!
    dockets.text = header(dockets.text)
    dockets.etag = '"cut"'
    await expect(sync(makeRun())).rejects.toThrow('LIS 20261 dockets: no bill is on a docket, though the last pass found some')
  })
})

describe('one session failing', () => {
  it('doesn\'t stop the next session\'s pass, and still fails the job', async () => {
    // 2026 Special Session I, served from the 2027 prefile rows.
    serve('20262', s2027())
    sessions['20261'].sponsors = null
    await claim('lis')
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow('LIS 20261: Sponsors.csv is missing')
    expect(await billId('HB1532', '20262')).toBeGreaterThan(3_000_000_000)
    await expect(billId('HB1', '20261')).rejects.toThrow()
  })
})

describe('reading the files with their ETags', () => {
  it('keeps an empty file\'s ETag, so it doesn\'t read as appeared on every pass', async () => {
    const files = s2026()
    files.subdockets = ''
    serve('20261', files)
    sessions['20261'].subdockets = { text: '', etag: '"20261-subdockets-v1"' }
    await claim('lis')
    await syncAndIngest()
    calls = []
    await sync(makeRun())
    expect(gets()).toEqual([])
  })

  it('reads in full when the stored ETag is from another version', async () => {
    await claim('lis')
    await syncAndIngest()
    const db = drizzle(env.DB, { schema })
    // The format before versioning: ETags by file, with no version.
    const old = JSON.stringify(Object.fromEntries((Object.keys(LIS_FILES) as LisFile[]).map(f => [f, `"20261-${f}-v1"`])))
    await db.update(schema.sessions).set({ snapshotEtag: old }).where(eq(schema.sessions.sessionTag, '20261'))
    calls = []
    await sync(makeRun())
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
  })

  it('checks every file\'s ETag first, and reads none when nothing changed', async () => {
    await claim('lis')
    await syncAndIngest()
    expect(heads().filter(f => f !== 'bills')).toEqual([])
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
    const before = await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)

    calls = []
    await sync(makeRun())
    // At 5 ET the session list refreshes too, which checks BILLS.CSV once more.
    expect([...new Set(heads())].sort()).toEqual(Object.keys(LIS_FILES).sort())
    expect(gets()).toEqual([])
    expect(await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)).toEqual(before)
  })

  it('reads every file when one changed, and checks against the new ETags next time', async () => {
    await claim('lis')
    await syncAndIngest()

    const files = s2026()
    files.bills = files.bills.replace('Minimum wage; increases', 'Minimum wage; raises')
    serve('20261', files)
    sessions['20261'].bills!.etag = '"20261-bills-v2"'
    calls = []
    const { run } = await syncAndIngest()
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
    expect(queuedIds(run)).toEqual([await billId('HB1')])
    expect((await getJson(`/bills/${toLegacyHandle(await billId('HB1'))}`)).title).toMatch(/^Minimum wage; raises/)

    calls = []
    await sync(makeRun())
    expect(gets()).toEqual([])
  })

  it('reads every file when one appears or goes, or is served without an ETag', async () => {
    await claim('lis')
    await syncAndIngest()

    sessions['20261'].subdockets = null
    calls = []
    // A subdocket file the last pass read can't go missing: the pass reads, then fails closed.
    await expect(sync(makeRun())).rejects.toThrow('SUBDOCKET.CSV is missing')
    expect(gets()).toContain('bills')

    serve('20261', s2026())
    calls = []
    await syncAndIngest()
    sessions['20261'].members!.etag = ''
    calls = []
    await sync(makeRun())
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
  })

  it('reads in full on a forced run, and after Virginia is claimed again', async () => {
    await claim('lis')
    await syncAndIngest()

    calls = []
    expect((await central('POST', '/admin/providers/lis/sync', makeRun())).status).toBe(200)
    expect(heads().filter(f => f !== 'bills')).toEqual([])
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())

    const db = drizzle(env.DB, { schema })
    await db.delete(schema.billTenants)
    expect((await claim('legiscan')).status).toBe(200)
    expect((await claim('lis')).status).toBe(200)
    calls = []
    await sync(makeRun())
    expect(gets().sort()).toEqual(Object.keys(LIS_FILES).sort())
  })
})
