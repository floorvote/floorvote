import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { and, eq, like } from 'drizzle-orm'
import * as schema from '../../src/db/schema'

// Committee meetings from the Congress.gov API at the main seam (#619): the
// API's recorded answers go in (the list, and a detail for each meeting), with
// the network stubbed at fetch. What comes out is what an instance would see:
// central's body calendar, each bill's calendar, and the notifications queued
// for the instance. The meetings are real answers recorded on October 17,
// 2026, and a test that needs another shape edits a copy, as it says. The
// bills they take up are the recorded Bill Status files, which a test points
// a meeting at by editing the meeting's related items.
const net = vi.hoisted(() => ({ paced: [] as { url: string; ratePerSec: number; bucketKey?: string }[] }))
vi.mock('../../src/lib/rateLimitedFetch', () => ({
  // Unpaced, so a test doesn't wait six seconds for each request, but recording the pace each request asked for.
  rateLimitedFetch: async (url: string, init: RequestInit | undefined, opts: { ratePerSec: number; bucketKey?: string; onRequest?: () => void }) => {
    net.paced.push({ url, ratePerSec: opts.ratePerSec, bucketKey: opts.bucketKey })
    const res = await fetch(url, init)
    opts.onRequest?.()
    return res
  },
}))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { govinfo } from '../../src/providers/govinfo'
import { clearRollCallCaches } from '../../src/providers/govinfo/client'
import { clearMeetingCaches, DETAILS_PER_PASS, LIST_PAGE_SIZE, QUARANTINE_AFTER } from '../../src/providers/govinfo/meetings'
import { runBodyEventSync } from '../../src/cron/body-events'
import { toHandle } from '../../src/lib/billHandle'
import { providerContext } from '../../src/lib/providerContext'
import { mainSeam, resetCentral, type Run } from '../helpers/mainSeam'
import { buildZip, fileType, fixtureFiles, serveZip } from '../helpers/govinfoZip'
import { rollCallBillFiles, rollCallNetwork } from '../helpers/govinfoRollCalls'
import { CONGRESS_KEY, MeetingFeed, json } from '../helpers/govinfoMeetings'

const ZIP_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/BILLSTATUS-\d+-([a-z]+)\.zip$/
const FILE_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/(BILLSTATUS-\d+[a-z]+\d+\.xml)$/
const PDF_URL = /^https:\/\/www\.govinfo\.gov\/content\/pkg\/([A-Za-z0-9-]+)\/pdf\/\1\.pdf$/
const WINDOW = 'from=2026-09-01&to=2027-01-31'
/** How many of the recorded meetings are dated in the window (September 2026 through January 2027). */
const IN_WINDOW = 13

/** The recorded meetings, by what each is. All real; a test edits a copy. */
const HEARING = '119544' // Sep 15, 10:15 ET: a House subcommittee's hearing, no bills
const MARKUP = '119567' // Sep 15, 16:00 ET: Oversight's markup
const UPCOMING = '119583' // Oct 23, 10:00 ET: a field hearing of Education and Workforce, still to come
const OCT_HEARING = '119575' // Oct 6, 09:00 ET: a field hearing of Ways and Means
const NAMELESS = '119538' // Sep 16, 10:00 ET: held by a committee the API gives no name for (hlzs00)
const A_MEETING = '119528' // Sep 3, 09:00 ET: typed "Meeting", Energy and Commerce's Environment subcommittee

const uid = (id: string) => `body-govinfo-${id}@floorvote.org`

let feed: MeetingFeed
/** What the stubbed GovInfo, House Clerk, and Senate answer. */
let files: Map<string, string>
let served: Map<string, () => Response>
/** Every address asked for, in order. */
let calls: string[]

/** The email binding ops alerts go out through, so a test sees each alert sent. The address is made up. */
const mail = { send: vi.fn(async (_message: any) => ({})) }
const ALERTS_TO = 'ops@example.org'
const seam = mainSeam(govinfo, { tenantId: 'usteam', env: { CONGRESS_API_KEY: CONGRESS_KEY, EMAIL_PROVIDER: 'cloudflare', EMAIL: mail, ALERT_EMAILS: ALERTS_TO } })
const keyless = mainSeam(govinfo, { tenantId: 'usteam' })
const { makeRun, sentToTenant, getJson, queuedIds } = seam
const db = () => drizzle(env.DB, { schema })
const billId = (number: string) => seam.billIdOf(number)
const bill = async (number: string) => getJson(`/bills/${toHandle(await billId(number))}`)

function serveZips() {
  return (type: string) => serveZip(buildZip(
    [...files].filter(([name]) => fileType(name) === type).map(([name, data]) => ({ name, data })),
  ), { headers: { 'last-modified': 'Sat, 17 Oct 2026 00:19:30 GMT' } }).response
}

beforeEach(async () => {
  // The day the meetings were recorded: the window is last month through three months ahead.
  await resetCentral('2026-10-17T13:00:00Z')
  clearRollCallCaches()
  clearMeetingCaches()
  mail.send.mockClear()
  net.paced.length = 0
  files = new Map([...fixtureFiles, ...rollCallBillFiles])
  served = rollCallNetwork()
  calls = []
  feed = new MeetingFeed()
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    const congress = feed.answer(url, init)
    if (congress) return congress
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
  // The instance follows Congress with keywords that match four recorded bills' titles.
  await seam.addTenant('US', ['alaska native village', 'arkansas valley conduit', 'agriculture, rural development', 'choice for veterans'])
  await seam.claim('US', 'govinfo')
  // Congress's bills and its session are already in central when the key is set, as they are in a deployment
  // that claimed US before it turned on the calendar.
  await seam.sync()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The recorded meetings, pointed at recorded bills where a test needs one with bills on it. */
function linkBills() {
  const bills = (...numbers: [type: string, number: string][]) => (m: any) => {
    m.relatedItems = { bills: numbers.map(([type, number]) => ({ congress: 119, number, type, url: `https://api.congress.gov/v3/bill/119/${type.toLowerCase()}/${number}?format=json` })) }
  }
  feed.edit(UPCOMING, bills(['HR', '43'], ['HR', '131']))
  feed.edit(MARKUP, bills(['HR', '43']))
  feed.edit(OCT_HEARING, bills(['S', '296']))
}

/** One hourly pass: the body calendar sync, then the bill sync and the ingest of the bills it queues. */
async function pass(run: Run = makeRun(), opts?: { allowRetries?: boolean }) {
  clearMeetingCaches()
  const reports = await runBodyEventSync(govinfo, run.env as any, db())
  return { reports, ...(await seam.syncAndIngest(run, opts)) }
}

/** Just the body calendar's sync, as a new isolate would run it. */
async function syncCalendar(run: Run = makeRun()) {
  clearMeetingCaches()
  return runBodyEventSync(govinfo, run.env as any, db())
}

async function events(): Promise<{ events: any[]; byUid: Map<string, any> }> {
  const body = await getJson(`/tenants/usteam/body-events?${WINDOW}`)
  return { events: body.events, byUid: new Map<string, any>(body.events.map((e: any) => [e.uid, e])) }
}

/** One body event, after checking that central serves it. */
async function eventOf(meetingId: string): Promise<any> {
  const { byUid } = await events()
  expect(byUid.has(uid(meetingId)), `a body event for meeting ${meetingId}`).toBe(true)
  return byUid.get(uid(meetingId))
}
/** The calendar block of the last notification an ingest queued for the instance about a bill, after checking there is one. */
function calendarOf(run: Run, id: number): any {
  const calendar = sentToTenant(run).filter((m: any) => m.billId === toHandle(id) && m.calendar).pop()?.calendar
  expect(calendar, `a calendar notification for bill ${id}`).toBeDefined()
  return calendar
}
const changeList = (calendar: any) => calendar.changes.map((c: any) => [c.changeType, c.identityKey])
const billEntries = async (number: string) => (await bill(number)).calendar as any[]
const logged = async () => (await db().select().from(schema.apiCallLog).where(like(schema.apiCallLog.callType, 'govinfo:Congress%')).all())
/** What is printed to the console, as one string. */
function consoleText(spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies.flatMap(s => s.mock.calls.flat()).map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join('\n')
}

describe('without a Congress.gov key', () => {
  it('syncs and ingests bills as before, asks the API for nothing, and has an empty body calendar', async () => {
    // The provider has a calendar and takes the key, so an empty one is what no key means, not a provider with none.
    expect(govinfo.listBodyEvents).toBeTypeOf('function')
    expect(govinfo.envKeys).toEqual(['CONGRESS_API_KEY'])
    linkBills()
    const run = keyless.makeRun()
    // Five months asked, and nothing in any of them.
    expect(await runBodyEventSync(govinfo, run.env as any, db())).toEqual([{ state: 'US', months: 5, failed: 0, events: 0, written: 0 }])
    await keyless.syncAndIngest(run)
    const messages = await keyless.ingest([await billId('HB43'), await billId('SB296')], run)
    expect(messages).toHaveLength(2)
    for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
    expect((await bill('HB43')).sponsors.length).toBeGreaterThan(0)
    expect(feed.requests).toEqual([])
    expect(calls.filter(u => u.startsWith('https://api.congress.gov'))).toEqual([])
    expect((await getJson(`/tenants/usteam/body-events?${WINDOW}`, run))).toMatchObject({ events: [] })
    for (const number of ['HB43', 'HB131', 'SB296']) expect((await bill(number)).calendar).toEqual([])
  })

  it('answers each month of the body calendar with an empty list', async () => {
    expect(govinfo.listBodyEvents).toBeTypeOf('function')
    const ctx = { env: {}, today: '2026-10-17', logCall: vi.fn(), ids: vi.fn(), knownIds: vi.fn(), people: vi.fn(), cache: { list: vi.fn(), put: vi.fn(), drop: vi.fn() } } as any
    expect(await govinfo.listBodyEvents!('US', { from: '2026-10-01', to: '2026-10-31' }, ctx)).toEqual([])
    expect(ctx.logCall).not.toHaveBeenCalled()
    expect(ctx.cache.list).not.toHaveBeenCalled()
    expect(ctx.cache.put).not.toHaveBeenCalled()
  })

  it('leaves the calendar entries bills already have when the key is taken away', async () => {
    linkBills()
    await pass()
    const before = await billEntries('HB43')
    expect(before).toHaveLength(2)
    // The key is gone: bills sync as before, with no word on their calendars, and so with no evidence that any entry went away.
    const run = keyless.makeRun()
    await keyless.syncAndIngest(run)
    await keyless.syncAndIngest(run)
    await keyless.syncAndIngest(run)
    expect(await billEntries('HB43')).toEqual(before)
    expect((await events()).events).toHaveLength(IN_WINDOW)
  })
})

describe('with a key, a recorded meeting', () => {
  it('appears as a body event under its event id, with its committee, date, and time', async () => {
    await pass()
    const { byUid } = await events()
    expect(byUid.get(uid(HEARING))).toEqual({
      uid: uid(HEARING),
      state: 'US',
      kind: 'hearing',
      type: 'Hearing',
      date: '2026-09-15',
      time: '10:15',
      timezone: 'America/New_York',
      committee: { committeeId: expect.any(String), name: 'House Education and Workforce Subcommittee on Health, Employment, Labor, and Pensions' },
      jointWith: null,
      location: '2175 Rayburn House Office Building',
      title: 'House Education and Workforce Subcommittee on Health, Employment, Labor, and Pensions hearing',
      agenda: [{ topic: '"Out of Touch: When Union Politics Leave Workers Behind"', billNumber: null }],
      url: 'https://www.congress.gov/event/119th-Congress/house-event/119544',
      eventHash: expect.stringMatching(/^[0-9a-f]{32}$/),
      cancelled: false,
      bills: [],
      covers: [],
    })
  })

  it('reaches instances covering US, once US is claimed, for last month through three months ahead', async () => {
    const run = makeRun()
    await syncCalendar(run)
    const { events: all } = await events()
    // The recorded meetings dated September 2026 through January 2027, and none from earlier or later.
    expect(all).toHaveLength(IN_WINDOW)
    expect(all.every(e => e.date >= '2026-09-01' && e.date <= '2027-01-31' && e.state === 'US')).toBe(true)
    expect(feed.meetings.size).toBeGreaterThan(IN_WINDOW)
    expect(all.some(e => e.uid === uid('118298'))).toBe(false)
    expect(await getJson('/bills/labels?state=US')).toMatchObject({ hasEvents: true, capabilities: { bodyEvents: true } })
  })

  it('serves a range only the meetings dated within it, both ends included', async () => {
    const ctx = providerContext(govinfo, makeRun().env as any, db())
    const on = async (from: string, to: string) => (await govinfo.listBodyEvents!('US', { from, to }, ctx)).map(e => e.event_id).sort()
    expect(await on('2026-09-15', '2026-09-15')).toEqual(['119544', '119553', '119567'])
    expect(await on('2026-09-16', '2026-09-16')).toEqual(['119538', '119558', '119573', '338746'])
    expect(await on('2026-09-15', '2026-09-16')).toEqual(['119538', '119544', '119553', '119558', '119567', '119573', '338746'])
    expect(await on('2026-10-24', '2026-11-30')).toEqual([])
    // Meetings of every month the recorded ones fall in are in some range: 2025's, too.
    expect((await on('2025-06-24', '2025-06-24'))).toEqual(['118298'])
  })

  it('reads the date and time in Eastern, whichever the season', async () => {
    feed.add('900001', HEARING, m => { m.date = '2026-12-09T15:30:00Z' })
    await pass()
    const { byUid } = await events()
    expect(byUid.get(uid(MARKUP))).toMatchObject({ date: '2026-09-15', time: '16:00', kind: 'markup', type: 'Markup' })
    expect(byUid.get(uid(OCT_HEARING))).toMatchObject({ date: '2026-10-06', time: '09:00' })
    expect(byUid.get(uid(UPCOMING))).toMatchObject({ date: '2026-10-23', time: '10:00' })
    expect(byUid.get(uid('900001'))).toMatchObject({ date: '2026-12-09', time: '10:30' })
  })

  it('puts a meeting typed "Meeting" on the calendar as a meeting', async () => {
    await pass()
    expect((await eventOf(A_MEETING))).toMatchObject({ kind: 'meeting', type: 'Meeting', date: '2026-09-03', time: '09:00' })
  })

  it('shows a field hearing\'s place from the address the API gives', async () => {
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({
      location: 'Northampton Community College, Fowler Family Southside Center, 511 East Third Street, Bethlehem, PA 18015',
    })
  })

  it('names a meeting for its committee and type, and keeps the meeting\'s own title as the first agenda item', async () => {
    await pass()
    const e = (await eventOf(UPCOMING))
    expect(e.title).toBe('House Education and Workforce hearing')
    expect(e.agenda[0]).toEqual({ topic: '“More Choices, Brighter Futures: Expanding Education Freedom”', billNumber: null })
  })

  it('shows a markup\'s agenda title on one line', async () => {
    await pass()
    const [item] = (await eventOf(MARKUP)).agenda
    expect(item.topic).not.toMatch(/[\r\n]/)
    expect(item.topic).toMatch(/^Full Committee business meeting to consider the following: 1\) H\.Res\./)
  })

  it('records the committee of every meeting, under the id a bill\'s own committee system code gives it', async () => {
    // A recorded bill is referred to hsii00. Hold a meeting under that same system code.
    feed.edit(UPCOMING, m => { m.committees = [{ name: 'House Natural Resources', systemCode: 'hsii00', url: 'https://api.congress.gov/v3/committee/house/hsii00?format=json' }] })
    await pass()
    await seam.ingest(await billId('HB43'))
    const referral = (await bill('HB43')).referrals.find((r: any) => r.committeeId)
    expect(referral).toBeDefined()
    expect((await eventOf(UPCOMING)).committee).toEqual({ committeeId: referral.committeeId, name: expect.any(String) })
    const rows = await db().select().from(schema.committees).where(eq(schema.committees.committeeId, Number(referral.committeeId))).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'US', provider: 'govinfo' })
  })

  it('records a committee no bill has named, minting its id from the system code', async () => {
    await pass()
    const hearing = (await eventOf(HEARING))
    const minted = await db().select().from(schema.providerIds)
      .where(and(eq(schema.providerIds.provider, 'govinfo'), eq(schema.providerIds.kind, 'committee'), eq(schema.providerIds.nativeKey, 'hsed02'))).all()
    expect(minted).toHaveLength(1)
    expect(hearing.committee.committeeId).toBe(String(minted[0].id))
    const rows = await db().select().from(schema.committees).where(eq(schema.committees.committeeId, minted[0].id)).all()
    expect(rows).toEqual([expect.objectContaining({ name: hearing.committee.name, chamber: 'H', state: 'US', provider: 'govinfo' })])
  })

  it('shows a joint committee\'s meeting with no congress.gov page named, under a committee of neither chamber', async () => {
    await pass()
    const e = await eventOf('338796')
    expect(e).toMatchObject({ kind: 'hearing', type: 'Open Hearing', date: '2026-09-28', url: null, committee: { name: expect.stringMatching(/Commission/) } })
    const rows = await db().select().from(schema.committees).where(eq(schema.committees.committeeId, Number(e.committee.committeeId))).all()
    expect(rows).toEqual([expect.objectContaining({ chamber: 'J', provider: 'govinfo' })])
  })

  it('shows a Senate business meeting that takes up sixty bills, each on the agenda', async () => {
    await pass()
    const e = await eventOf('338795')
    expect(e).toMatchObject({ kind: 'meeting', type: 'Open Business Meeting', date: '2026-09-30', time: '10:00', url: 'https://www.congress.gov/event/119th-Congress/senate-event/338795' })
    expect(e.agenda).toHaveLength(61)
    expect(e.agenda.filter((a: any) => a.billNumber).length).toBe(60)
    expect(e.agenda.map((a: any) => a.billNumber).filter(Boolean).every((n: string) => /^(HB|SB)\d+$/.test(n))).toBe(true)
  })

  it('writes nothing, and re-ingests nothing, on a pass after which nothing has changed', async () => {
    linkBills()
    await pass()
    const run = makeRun()
    const [report] = await runBodyEventSync(govinfo, run.env as any, db())
    expect(report).toMatchObject({ failed: 0, events: IN_WINDOW, written: 0 })
    await seam.sync(run)
    expect(queuedIds(run)).toEqual([])
  })

  it('holds a meeting by a committee the API gives no name for, naming no committee on it', async () => {
    await pass()
    const e = (await eventOf(NAMELESS))
    expect(e).toMatchObject({ committee: null, kind: 'hearing', date: '2026-09-16', time: '10:00', title: 'House hearing' })
    expect(e.agenda[0].topic).toMatch(/^Import Controls/)
  })

  it('holds a meeting with no committee at all, without one', async () => {
    feed.edit(HEARING, m => { m.committees = [] })
    await pass()
    expect((await eventOf(HEARING))).toMatchObject({ committee: null, title: 'House hearing' })
  })

  it('names the other committees of a joint meeting, and holds it under the first', async () => {
    feed.edit(HEARING, m => { m.committees.push({ name: 'House Judiciary', systemCode: 'hsju00', url: 'https://api.congress.gov/v3/committee/house/hsju00?format=json' }) })
    await pass()
    expect((await eventOf(HEARING))).toMatchObject({
      committee: { name: 'House Education and Workforce Subcommittee on Health, Employment, Labor, and Pensions' },
      jointWith: 'House Judiciary',
    })
  })

  it('leaves a meeting a bill\'s calendar has no part in on the body calendar alone, with no bills', async () => {
    await pass()
    for (const number of ['HB43', 'HB131', 'SB296']) expect(await billEntries(number)).toEqual([])
    expect((await eventOf(HEARING))).toMatchObject({ bills: [], covers: [] })
  })

  it('takes a meeting of a type it doesn\'t know for a meeting, on the body calendar and a bill\'s', async () => {
    feed.edit(UPCOMING, m => { m.type = 'Roundtable'; m.relatedItems = { bills: [{ congress: 119, number: '43', type: 'HR', url: 'https://api.congress.gov/v3/bill/119/hr/43?format=json' }] } })
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ kind: 'meeting', type: 'Roundtable' })
    expect(await billEntries('HB43')).toEqual([expect.objectContaining({ kind: 'meeting', type: 'Roundtable', date: '2026-10-23' })])
  })
})

describe('a meeting that takes up two bills', () => {
  it('puts an entry on both bills\' calendars, shown once as the body event', async () => {
    linkBills()
    await pass()
    const e = await eventOf(UPCOMING)
    expect(e.bills.sort()).toEqual([toHandle(await billId('HB131')), toHandle(await billId('HB43'))].sort())
    expect(e.agenda.map((a: any) => a.billNumber)).toEqual([null, 'HB43', 'HB131'])
    expect(e.agenda.slice(1).map((a: any) => a.topic)).toEqual(['H.R. 43', 'H.R. 131'])
    expect(e.covers).toHaveLength(2)
    expect(e.covers.map((c: any) => c.identityKey)).toEqual(['id:119583', 'id:119583'])

    for (const number of ['HB43', 'HB131']) {
      const entries = (await billEntries(number)).filter((c: any) => c.date === '2026-10-23')
      expect(entries).toEqual([{
        eventHash: expect.stringMatching(/^[0-9a-f]{32}$/),
        typeId: expect.any(Number),
        type: 'Hearing',
        kind: 'hearing',
        date: '2026-10-23',
        time: '10:00',
        location: 'Northampton Community College, Fowler Family Southside Center, 511 East Third Street, Bethlehem, PA 18015',
        description: expect.stringMatching(/^House Education and Workforce hearing: .More Choices, Brighter Futures/),
        coveredBy: uid(UPCOMING),
      }])
    }
  })

  it('gives each entry the meeting\'s event id as its identity, so a notification names it', async () => {
    linkBills()
    const { run } = await pass()
    const calendar = calendarOf(run, await billId('HB131'))
    expect(calendar.events).toEqual([expect.objectContaining({ identityKey: 'id:119583', kind: 'hearing', date: '2026-10-23', coveredBy: uid(UPCOMING) })])
    expect(changeList(calendar)).toEqual([['hearing_added', 'id:119583']])
  })

  it('gives a bill an entry for each meeting that takes it up, of the kind of each', async () => {
    linkBills()
    await pass()
    expect((await billEntries('HB43')).map((c: any) => [c.kind, c.date, c.coveredBy])).toEqual([
      ['markup', '2026-09-15', uid(MARKUP)],
      ['hearing', '2026-10-23', uid(UPCOMING)],
    ])
    expect((await billEntries('SB296')).map((c: any) => [c.kind, c.date, c.time, c.coveredBy])).toEqual([['hearing', '2026-10-06', '09:00', uid(OCT_HEARING)]])
  })

  it('keeps a past meeting on a bill\'s calendar: a date passing is no reason to drop it', async () => {
    linkBills()
    await pass()
    // The markup was on September 15, before today, October 17, and the API still calls it "Scheduled".
    expect(recordedStatus(MARKUP)).toBe('Scheduled')
    expect((await billEntries('HB43')).some((c: any) => c.date === '2026-09-15')).toBe(true)
    await pass()
    await pass()
    expect((await billEntries('HB43')).some((c: any) => c.date === '2026-09-15')).toBe(true)
  })

  it('ignores a bill central has never synced', async () => {
    feed.edit(UPCOMING, m => { m.relatedItems = { bills: [{ congress: 119, number: '9999999', type: 'HR', url: 'x' }, { congress: 119, number: '43', type: 'HR', url: 'x' }] } })
    await pass()
    expect((await billEntries('HB43')).map((c: any) => c.date)).toEqual(['2026-10-23'])
    const e = (await eventOf(UPCOMING))
    expect(e.agenda.map((a: any) => a.billNumber)).toEqual([null, 'HB9999999', 'HB43'])
    expect(e.bills).toEqual([toHandle(await billId('HB43'))])
  })

  it('takes a bill type\'s number as LegiScan writes it: a House resolution is HR', async () => {
    feed.edit(UPCOMING, m => { m.relatedItems = { bills: [{ congress: 119, number: '492', type: 'HRES', url: 'x' }] } })
    await pass()
    expect((await eventOf(UPCOMING)).agenda.map((a: any) => [a.topic, a.billNumber])).toEqual([
      [expect.stringMatching(/^.More Choices/), null], ['H.Res. 492', 'HR492'],
    ])
  })
})

const recordedStatus = (id: string) => feed.meetings.get(id).meetingStatus

describe('cancelling', () => {
  it.each(['Canceled', 'Postponed'])('cancels the body event and the bill entries on the next pass, when the status becomes "%s"', async status => {
    linkBills()
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: false })
    expect((await billEntries('HB43')).map((c: any) => c.date)).toEqual(['2026-09-15', '2026-10-23'])

    feed.edit(UPCOMING, m => { m.meetingStatus = status })
    const { run } = await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: true })
    for (const number of ['HB43', 'HB131']) expect((await billEntries(number)).some((c: any) => c.date === '2026-10-23')).toBe(false)
    // At once: on positive evidence, not after two pulls.
    expect(changeList(calendarOf(run, await billId('HB131')))).toEqual([['hearing_cancelled', 'id:119583']])
    // The markup, which no one cancelled, stays.
    expect((await eventOf(MARKUP))).toMatchObject({ cancelled: false })
    expect((await billEntries('HB43')).map((c: any) => c.date)).toEqual(['2026-09-15'])
  })

  it('does not cancel a meeting already held that the API still calls "Scheduled"', async () => {
    linkBills()
    await pass()
    for (const id of [HEARING, MARKUP, NAMELESS, A_MEETING]) {
      expect(recordedStatus(id)).toBe('Scheduled')
      expect(new Date(feed.meetings.get(id).date) < new Date('2026-10-17T13:00:00Z')).toBe(true)
      expect((await events()).byUid.get(uid(id))).toMatchObject({ cancelled: false })
    }
    await pass()
    await pass()
    await pass()
    for (const id of [HEARING, MARKUP, NAMELESS, A_MEETING]) expect((await events()).byUid.get(uid(id))).toMatchObject({ cancelled: false })
    expect((await billEntries('HB43')).some((c: any) => c.date === '2026-09-15')).toBe(true)
  })

  it('does not cancel a meeting the API calls "Rescheduled", which is a meeting that moved', async () => {
    linkBills()
    await pass()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Rescheduled'; m.date = '2026-11-12T15:00:00Z' })
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: false, date: '2026-11-12', time: '10:00' })
    expect((await billEntries('HB131')).map((c: any) => [c.date, c.time])).toEqual([['2026-11-12', '10:00']])
  })

  it('brings a cancelled meeting back when the API says it is scheduled again', async () => {
    linkBills()
    await pass()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Canceled' })
    await pass()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Scheduled' })
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: false })
    expect((await billEntries('HB131')).map((c: any) => c.date)).toEqual(['2026-10-23'])
  })

  it('cancels a meeting the API\'s list stops naming, as for any body event: after two passes', async () => {
    await pass()
    feed.remove(UPCOMING)
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: false })
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: true })
    expect((await eventOf(MARKUP))).toMatchObject({ cancelled: false })
  })

  it('never cancels a meeting for being cancelled before this central ever saw it', async () => {
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Canceled' })
    await pass()
    // A cancelled meeting that was never stored has nothing to cancel, and nothing to show. The others are shown.
    expect((await events()).events).toHaveLength(IN_WINDOW - 1)
    expect((await events()).byUid.has(uid(UPCOMING))).toBe(false)
  })
})

describe('a meeting that changes', () => {
  it('keeps its identity when its time changes: subscribers see an update, not a cancellation and a new entry', async () => {
    linkBills()
    await pass()
    const before = (await eventOf(UPCOMING))
    feed.edit(UPCOMING, m => { m.date = '2026-10-23T18:30:00Z' })
    const { run } = await pass()
    const after = (await eventOf(UPCOMING))
    expect(after).toMatchObject({ uid: uid(UPCOMING), time: '14:30', date: '2026-10-23', cancelled: false })
    expect(after.eventHash).not.toBe(before.eventHash)
    expect((await events()).events).toHaveLength(IN_WINDOW)

    const calendar = calendarOf(run, await billId('HB131'))
    expect(changeList(calendar)).toEqual([['hearing_changed', 'id:119583']])
    expect(calendar.events).toEqual([expect.objectContaining({ identityKey: 'id:119583', time: '14:30' })])
    expect((await billEntries('HB131')).map((c: any) => [c.date, c.time])).toEqual([['2026-10-23', '14:30']])
    // One row for the meeting on the bill, updated in place.
    const rows = await db().select().from(schema.billCalendar).where(eq(schema.billCalendar.eventId, '119583')).all()
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.cancelledAt === null && r.missedPulls === 0)).toBe(true)
  })

  it('keeps its identity when its date moves to another month', async () => {
    linkBills()
    await pass()
    feed.edit(UPCOMING, m => { m.date = '2026-12-02T15:00:00Z' })
    const { run } = await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ date: '2026-12-02', time: '10:00', cancelled: false })
    expect(changeList(calendarOf(run, await billId('HB131')))).toEqual([['hearing_changed', 'id:119583']])
  })

  it('keeps its identity when it moves out of the window and back', async () => {
    await pass()
    feed.edit(UPCOMING, m => { m.date = '2027-06-02T15:00:00Z' })
    await pass()
    feed.edit(UPCOMING, m => { m.date = '2026-10-30T14:00:00Z' })
    await pass()
    expect((await eventOf(UPCOMING))).toMatchObject({ date: '2026-10-30', cancelled: false })
  })

  it('changes the event and its bills\' entries when it moves rooms, retitles, or changes committee', async () => {
    linkBills()
    await pass()
    const hash = (await eventOf(UPCOMING)).eventHash
    feed.edit(UPCOMING, m => { m.title = 'A new name for the hearing' })
    await pass()
    const retitled = (await eventOf(UPCOMING))
    expect(retitled.agenda[0].topic).toBe('A new name for the hearing')
    expect(retitled.eventHash).not.toBe(hash)
    expect((await billEntries('HB131'))[0].description).toContain('A new name for the hearing')
    feed.edit(UPCOMING, m => { m.location = { building: 'Rayburn House Office Building', room: '2175' } })
    await pass()
    expect((await eventOf(UPCOMING)).location).toBe('2175 Rayburn House Office Building')
    expect((await billEntries('HB131'))[0].location).toBe('2175 Rayburn House Office Building')
  })

  it('adds an entry to a bill the meeting takes up later, and keeps the other\'s', async () => {
    linkBills()
    await pass()
    feed.edit(UPCOMING, m => { m.relatedItems.bills.push({ congress: 119, number: '3132', type: 'HR', url: 'x' }) })
    await pass()
    expect((await billEntries('HB3132')).map((c: any) => c.date)).toEqual(['2026-10-23'])
    expect((await billEntries('HB131')).map((c: any) => c.date)).toEqual(['2026-10-23'])
    expect((await eventOf(UPCOMING)).bills).toHaveLength(3)
  })

  it('leaves a bill\'s entry to go away, after two passes, once the meeting no longer takes the bill up', async () => {
    linkBills()
    await pass()
    feed.edit(UPCOMING, m => { m.relatedItems = { bills: [m.relatedItems.bills[0]] } })
    await pass()
    expect((await billEntries('HB131')).map((c: any) => c.date)).toEqual(['2026-10-23'])
    await pass()
    expect((await billEntries('HB131')).map((c: any) => c.date)).toEqual([])
    expect((await billEntries('HB43')).map((c: any) => c.date)).toEqual(['2026-09-15', '2026-10-23'])
  })

  it('re-ingests the bills a meeting\'s change touches, and no others', async () => {
    linkBills()
    await pass()
    feed.edit(UPCOMING, m => { m.date = '2026-10-23T18:30:00Z' })
    clearMeetingCaches()
    const run = makeRun()
    await runBodyEventSync(govinfo, run.env as any, db())
    await seam.sync(run)
    expect(queuedIds(run).sort()).toEqual([await billId('HB131'), await billId('HB43')].sort())
  })

  it('re-ingests nothing when only a field the provider doesn\'t show changes', async () => {
    linkBills()
    await pass()
    feed.edit(UPCOMING, m => { m.meetingDocuments = [{ documentType: 'Support Document', format: 'PDF', name: 'A new document', url: 'https://www.congress.gov/119/meeting/house/119583/documents/x.pdf' }] })
    clearMeetingCaches()
    const run = makeRun()
    await runBodyEventSync(govinfo, run.env as any, db())
    await seam.sync(run)
    expect(queuedIds(run)).toEqual([])
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: false })
  })

  it('does not change a bill\'s hash when a meeting takes up some other bill', async () => {
    linkBills()
    await pass()
    feed.edit(OCT_HEARING, m => { m.date = '2026-10-06T14:00:00Z' })
    clearMeetingCaches()
    const run = makeRun()
    await runBodyEventSync(govinfo, run.env as any, db())
    await seam.sync(run)
    expect(queuedIds(run)).toEqual([await billId('SB296')])
  })
})

describe('what the API is asked, and what is kept of it', () => {
  it('carries the key in the X-Api-Key header of every request, and never in an address', async () => {
    linkBills()
    await pass()
    expect(feed.requests.length).toBeGreaterThan(5)
    for (const r of feed.requests) {
      expect(r.headers['x-api-key'], r.url).toBe(CONGRESS_KEY)
      expect(r.url).not.toContain(CONGRESS_KEY)
      expect(r.url.toLowerCase()).not.toMatch(/api[_-]?key|token|secret/)
      expect(r.method).toBe('GET')
    }
    // Nothing else is sent the key.
    for (const url of calls.filter(u => !u.startsWith('https://api.congress.gov/'))) expect(url).not.toContain(CONGRESS_KEY)
  })

  it('never puts the key in the call log, the console, or what an instance is told', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    linkBills()
    const { run } = await pass()
    // The key was in use: requests went out carrying it.
    expect(feed.requests.length).toBeGreaterThan(5)
    expect(feed.requests.every(r => r.headers['x-api-key'] === CONGRESS_KEY)).toBe(true)
    expect(consoleText(spies)).not.toContain(CONGRESS_KEY)
    expect(JSON.stringify(await db().select().from(schema.apiCallLog).all())).not.toContain(CONGRESS_KEY)
    expect(JSON.stringify(sentToTenant(run))).not.toContain(CONGRESS_KEY)
    expect(JSON.stringify(await events())).not.toContain(CONGRESS_KEY)
    expect(JSON.stringify(await db().select().from(schema.providerIds).all())).not.toContain(CONGRESS_KEY)
    for (const table of [schema.billCalendar, schema.bodyEvents, schema.committees, schema.bills]) {
      expect(JSON.stringify(await db().select().from(table).all())).not.toContain(CONGRESS_KEY)
    }
    const cache = await env.DB.prepare('SELECT * FROM provider_cache').all()
    expect(JSON.stringify(cache.results)).not.toContain(CONGRESS_KEY)
    // Not even when a request fails.
    feed.override.list = () => new Response('Forbidden', { status: 403 })
    await syncCalendar()
    expect(consoleText(spies)).not.toContain(CONGRESS_KEY)
  })

  it('logs every request it sends, as govinfo:CongressMeetingList or govinfo:CongressMeeting', async () => {
    await pass()
    const rows = await logged()
    expect(feed.requests.length).toBeGreaterThan(0)
    expect(rows).toHaveLength(feed.requests.length)
    expect(rows.filter(r => r.callType === 'govinfo:CongressMeetingList')).toHaveLength(feed.listRequests.length + feed.recentRequests.length)
    expect(rows.filter(r => r.callType === 'govinfo:CongressMeeting')).toHaveLength(feed.detailRequests.length)
    // They name what was asked for, and nothing else.
    const detail = rows.find(r => r.callType === 'govinfo:CongressMeeting')!
    expect(JSON.parse(detail.params)).toEqual({ congress: 119, chamber: expect.stringMatching(/^(house|senate|nochamber)$/), eventId: expect.stringMatching(/^\d+$/) })
    const list = rows.find(r => r.callType === 'govinfo:CongressMeetingList')!
    expect(JSON.parse(list.params)).toEqual({ congress: 119, offset: 0 })
    // None of them is a LegiScan call: the dashboard counts only calls with no colon in the name.
    expect(rows.every(r => r.callType.includes(':'))).toBe(true)
  })

  it('asks at no more than 10 requests a minute, every request to the one pace', async () => {
    await pass()
    const asked = net.paced.filter(p => p.url.startsWith('https://api.congress.gov/'))
    expect(asked).toHaveLength(feed.requests.length)
    expect(asked.length).toBeGreaterThan(0)
    for (const p of asked) expect(p.ratePerSec, p.url).toBeLessThanOrEqual(10 / 60 + 1e-9)
    expect(new Set(asked.map(p => p.bucketKey)).size).toBe(1)
    expect(asked[0].bucketKey).toBeTruthy()
  })

  it('does not follow a redirect, so the key goes to api.congress.gov and nowhere else', async () => {
    await pass()
    expect(feed.requests.length).toBeGreaterThan(0)
    for (const r of feed.requests) expect(r.redirect, r.url).toBe('manual')

    clearMeetingCaches()
    feed.override.list = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
    const before = (await events()).events
    await syncCalendar()
    expect(calls.some(u => u.startsWith('https://evil.example'))).toBe(false)
    expect((await events()).events).toEqual(before)
  })

  it('asks the list for 250 meetings at a time, to the end, and reads each page\'s meetings', async () => {
    expect(LIST_PAGE_SIZE).toBe(250)
    for (let i = 0; i < 300; i++) feed.add(String(500000 + i), HEARING, m => { m.date = '2025-03-01T15:00:00Z' })
    await syncCalendar()
    expect(feed.listRequests.map(r => new URL(r.url).searchParams.get('offset'))).toEqual(['0', '250'])
    for (const r of feed.listRequests) {
      const p = new URL(r.url).searchParams
      expect(p.get('limit')).toBe('250')
      expect(p.get('format')).toBe('json')
    }
    expect(new Set(feed.listRequests.map(r => new URL(r.url).pathname))).toEqual(new Set(['/v3/committee-meeting/119']))
  })

  it('asks for each meeting by its Congress, chamber, and event id', async () => {
    await syncCalendar()
    const paths = feed.detailRequests.map(r => new URL(r.url).pathname)
    expect(paths).toContain('/v3/committee-meeting/119/house/119544')
    expect(paths).toContain('/v3/committee-meeting/119/nochamber/337125')
    expect(paths).toContain('/v3/committee-meeting/119/senate/336604')
  })
})

describe('what one pass reads, and what it keeps', () => {
  it('reads each meeting once, and asks for no meeting again while the list says it is unchanged', async () => {
    await syncCalendar()
    const first = feed.detailIds.length
    expect(first).toBe(feed.meetings.size)
    expect(new Set(feed.detailIds).size).toBe(first)

    await syncCalendar()
    await syncCalendar()
    expect(feed.detailIds).toHaveLength(first)
    // One read of the list a pass: its pages, and the meetings changed since the read began.
    expect(feed.listRequests).toHaveLength(3)
    expect(feed.recentRequests).toHaveLength(3)
  })

  it('asks again for a meeting the list says changed, and only that one', async () => {
    await syncCalendar()
    const first = feed.detailIds.length
    feed.edit(UPCOMING, m => { m.title = 'Another title' })
    feed.edit(HEARING, m => { m.meetingStatus = 'Canceled' })
    await syncCalendar()
    expect(feed.detailIds.slice(first).sort()).toEqual([HEARING, UPCOMING].sort())
  })

  it('serves five months of the calendar from one read of the API', async () => {
    const run = makeRun()
    clearMeetingCaches()
    await runBodyEventSync(govinfo, run.env as any, db())
    // Five months asked of the provider, one read of the list.
    expect(feed.listRequests).toHaveLength(1)
    expect(feed.recentRequests).toHaveLength(1)
    expect(feed.detailIds.length).toBe(feed.meetings.size)
  })

  it('keeps what it reads, so another isolate with nothing in memory asks only for what changed', async () => {
    await syncCalendar()
    const first = feed.requests.length
    clearMeetingCaches()
    await syncCalendar()
    // Just the list: a page of it, and the meetings changed since the read began.
    expect(feed.requests.length - first).toBe(2)
    expect((await events()).events).toHaveLength(IN_WINDOW)
  })

  it('reads at most DETAILS_PER_PASS meetings in a pass, newest event ids first, and serves what it has read', async () => {
    expect(DETAILS_PER_PASS).toBe(60)
    // 80 more meetings, with event ids below every recorded one, all in the window.
    for (let i = 0; i < 80; i++) feed.add(String(100000 + i), HEARING, m => { m.date = `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T15:00:00Z` })
    const recorded = feed.meetings.size - 80
    await syncCalendar()
    expect(feed.detailIds).toHaveLength(DETAILS_PER_PASS)
    // Every recorded meeting is read first, then the new ones from the highest id down.
    const ids = feed.detailIds.map(Number)
    expect(ids.slice(0, recorded).sort((a, b) => a - b)).toEqual([...feed.meetings.keys()].map(Number).filter(n => n >= 100080).sort((a, b) => a - b))
    expect(ids.slice(recorded)).toEqual(Array.from({ length: DETAILS_PER_PASS - recorded }, (_, i) => 100079 - i))
    // What was read is served: the recorded meetings in the window, and the new ones read.
    expect((await events()).events).toHaveLength(IN_WINDOW + (DETAILS_PER_PASS - recorded))

    // The next pass reads the rest, and nothing twice.
    await syncCalendar()
    expect(feed.detailIds).toHaveLength(feed.meetings.size)
    expect(new Set(feed.detailIds).size).toBe(feed.meetings.size)
    expect((await events()).events).toHaveLength(IN_WINDOW + 80)
  })

  it('cancels nothing while it is still reading its first meetings', async () => {
    for (let i = 0; i < 80; i++) feed.add(String(100000 + i), HEARING, m => { m.date = `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T15:00:00Z` })
    for (let i = 0; i < 4; i++) {
      await syncCalendar()
      expect((await events()).events.filter(e => e.cancelled)).toEqual([])
    }
    expect((await events()).events).toHaveLength(IN_WINDOW + 80)
  })

  it('reads a meeting changed since a pass before one it has never read', async () => {
    for (let i = 0; i < 80; i++) feed.add(String(100000 + i), HEARING, m => { m.date = `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T15:00:00Z` })
    await syncCalendar()
    await syncCalendar()
    const read = feed.detailIds.length
    // A new meeting with the lowest id of all, and a recorded one that changed.
    feed.add('99999', HEARING)
    feed.edit(HEARING, m => { m.meetingStatus = 'Canceled' })
    await syncCalendar()
    expect(feed.detailIds.slice(read)).toEqual([HEARING, '99999'])
  })

  it('drops from what it keeps a meeting the list no longer names', async () => {
    await syncCalendar()
    feed.remove(UPCOMING)
    await syncCalendar()
    const kept = await env.DB.prepare(`SELECT key FROM provider_cache WHERE provider = 'govinfo' AND key LIKE 'meeting/%'`).all<{ key: string }>()
    expect(kept.results.map(r => r.key)).not.toContain(`meeting/119/${UPCOMING}`)
    expect(kept.results.map(r => r.key)).toContain(`meeting/119/${HEARING}`)
    expect(kept.results).toHaveLength(feed.meetings.size)
  })

  it('reads a meeting again that it kept something unreadable for', async () => {
    await syncCalendar()
    await env.DB.prepare(`UPDATE provider_cache SET value = 'not json' WHERE key = ?`).bind(`meeting/119/${UPCOMING}`).run()
    const first = feed.detailIds.length
    await syncCalendar()
    expect(feed.detailIds.slice(first)).toEqual([UPCOMING])
    expect((await eventOf(UPCOMING))).toMatchObject({ date: '2026-10-23' })
  })

  it('keeps the copy it read again for an unreadable one, so the next pass reads nothing', async () => {
    await syncCalendar()
    await env.DB.prepare(`UPDATE provider_cache SET value = 'not json' WHERE key = ?`).bind(`meeting/119/${UPCOMING}`).run()
    await syncCalendar()
    const row = await env.DB.prepare(`SELECT value FROM provider_cache WHERE provider = 'govinfo' AND key = ?`).bind(`meeting/119/${UPCOMING}`).first<{ value: string }>()
    expect(row && JSON.parse(row.value).meeting.eventId).toBe(UPCOMING)
    const second = feed.detailIds.length
    await syncCalendar()
    expect(feed.detailIds.slice(second)).toEqual([])
  })
})

describe('when the API fails', () => {
  /** A calendar with its first pass done, and what it shows then. */
  async function established() {
    linkBills()
    await pass()
    const shown = (await events()).events
    const entries = await billEntries('HB43')
    // There is a calendar to leave as it was.
    expect(shown).toHaveLength(IN_WINDOW)
    expect(entries).toHaveLength(2)
    return { events: shown, entries, entries131: await billEntries('HB131') }
  }
  async function unchanged(before: Awaited<ReturnType<typeof established>>) {
    expect((await events()).events).toEqual(before.events)
    expect(await billEntries('HB43')).toEqual(before.entries)
    expect(await billEntries('HB131')).toEqual(before.entries131)
  }

  const failures: [string, () => Response][] = [
    ['answers 429', () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '3600' } })],
    ['answers 500', () => new Response('Internal Server Error', { status: 500 })],
    ['answers 403 for its key', () => json({ error: { code: 'API_KEY_INVALID' } }, 403)],
    ['answers 404', () => new Response('Not Found', { status: 404 })],
    ['answers a web page', () => new Response('<html>Down for maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['answers an empty body', () => new Response('', { status: 200 })],
    ['answers JSON that isn\'t a list of meetings', () => json({ unexpected: true })],
    ['answers a list with no count', () => json({ committeeMeetings: [] })],
    ['answers a meeting with no event id', () => json({ committeeMeetings: [{ chamber: 'House', congress: 119, updateDate: '2026-10-16T19:47:29Z' }], pagination: { count: 1 } })],
  ]

  it.each(failures)('leaves the calendar as it was when the list %s', async (_what, answer) => {
    const before = await established()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Canceled' })
    feed.override.list = () => answer()
    const reports = await syncCalendar()
    expect(reports[0]).toMatchObject({ months: 0, failed: 5 })
    await seam.syncAndIngest(makeRun())
    await unchanged(before)
  })

  it.each(failures.slice(0, 7))('leaves the calendar as it was when a meeting\'s answer %s', async (_what, answer) => {
    const before = await established()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Canceled' })
    feed.override.detail = id => (id === UPCOMING ? answer() : null)
    const reports = await syncCalendar()
    expect(reports[0]).toMatchObject({ months: 0, failed: 5 })
    await seam.syncAndIngest(makeRun())
    await unchanged(before)
  })

  it('leaves the calendar as it was when the list stops short of its own count', async () => {
    const before = await established()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Canceled' })
    // A count of 3 more than the list holds: it changed while it was read, or was cut off.
    feed.countOffset = 3
    await syncCalendar()
    await seam.syncAndIngest(makeRun())
    await unchanged(before)
  })

  it('leaves the calendar as it was when the list names a meeting twice, as when it changes while it is read', async () => {
    const before = await established()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Canceled' })
    feed.override.list = () => json({
      committeeMeetings: [...feed.meetings.values()].concat([feed.meetings.get(HEARING)]).map(m => ({ chamber: m.chamber, congress: m.congress, eventId: m.eventId, updateDate: m.updateDate, url: 'x' })),
      pagination: { count: feed.meetings.size + 1 },
    })
    await syncCalendar()
    await seam.syncAndIngest(makeRun())
    await unchanged(before)
  })

  it('leaves the calendar as it was when a meeting is malformed, until it is fixed, and then shows every meeting', async () => {
    const before = await established()
    feed.add('900002', HEARING, m => { m.date = '2026-11-18T15:00:00Z' })
    feed.edit('900002', m => { delete m.date })
    // Short of the passes that quarantine it (below).
    for (let i = 0; i < QUARANTINE_AFTER - 1; i++) {
      await syncCalendar()
      await seam.syncAndIngest(makeRun())
      await unchanged(before)
    }
    expect((await events()).byUid.has(uid('900002'))).toBe(false)
    feed.edit('900002', m => { m.date = '2026-11-18T15:00:00Z' })
    await syncCalendar()
    expect((await eventOf('900002'))).toMatchObject({ date: '2026-11-18', time: '10:00' })
  })

  it('keeps what it read before a failure, so the pass after it reads only the rest', async () => {
    await established()
    feed.add('900003', HEARING, m => { m.date = '2026-11-18T15:00:00Z' })
    feed.add('900004', HEARING, m => { m.date = '2026-11-19T15:00:00Z' })
    feed.add('900005', HEARING, m => { m.date = '2026-11-20T15:00:00Z' })
    // The highest id is read first, and the middle one fails.
    feed.override.detail = id => (id === '900004' ? new Response('boom', { status: 500 }) : null)
    const first = feed.detailIds.length
    await syncCalendar()
    expect(feed.detailIds.slice(first)).toEqual(['900005', '900004'])
    feed.override.detail = undefined
    const second = feed.detailIds.length
    await syncCalendar()
    // 900005 was read and kept. The pass reads the one that failed, and the one after it.
    expect(feed.detailIds.slice(second)).toEqual(['900004', '900003'])
    expect([...(await events()).byUid.keys()]).toEqual(expect.arrayContaining([uid('900003'), uid('900004'), uid('900005')]))
  })

  it('shows nothing of a failed pass\'s new meetings on a bill, any more than on the body calendar', async () => {
    await established()
    feed.edit(UPCOMING, m => { m.meetingStatus = 'Canceled' })
    feed.add('900006', HEARING, m => { m.date = '2026-11-18T15:00:00Z'; m.relatedItems = { bills: [{ congress: 119, number: '43', type: 'HR', url: 'x' }] } })
    feed.edit(HEARING, m => { m.title = 'changed' })
    feed.override.detail = id => (id === HEARING ? new Response('boom', { status: 500 }) : null)
    await syncCalendar()
    // The cancelled meeting was read before the failure, and a bill still shows it as it was.
    await seam.syncAndIngest(makeRun())
    expect((await billEntries('HB131')).map((c: any) => c.date)).toEqual(['2026-10-23'])
    expect((await billEntries('HB43')).map((c: any) => c.date)).toEqual(['2026-09-15', '2026-10-23'])
    expect((await eventOf(UPCOMING))).toMatchObject({ cancelled: false })
  })

  it('never lets a failing calendar stop bills from syncing and ingesting', async () => {
    feed.override.list = () => new Response('down', { status: 500 })
    await pass()
    expect(feed.listRequests.length).toBeGreaterThan(0)
    const messages = await seam.ingest([await billId('HB43'), await billId('SB296')])
    expect(messages).toHaveLength(2)
    for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
    expect((await bill('HB43')).sponsors.length).toBeGreaterThan(0)
  })

  it('asks again on the next pass after a failure', async () => {
    feed.override.list = () => new Response('down', { status: 500 })
    await syncCalendar()
    const failed = feed.listRequests.length
    feed.override.list = undefined
    await syncCalendar()
    expect(feed.listRequests.length).toBeGreaterThan(failed)
    expect((await events()).events).toHaveLength(IN_WINDOW)
  })

  it('asks the API once for all five months, after a failure too', async () => {
    feed.override.list = () => new Response('down', { status: 500 })
    clearMeetingCaches()
    const run = makeRun()
    await runBodyEventSync(govinfo, run.env as any, db())
    expect(feed.listRequests).toHaveLength(1)
  })
})

describe('a meeting that can\'t be read, pass after pass', () => {
  /** The meetings the cache counts failing passes for: struck once or more, quarantined or not. */
  const failing = async () => (await env.DB.prepare(`SELECT key FROM provider_cache WHERE provider = 'govinfo' AND key LIKE 'failing/119/%' ORDER BY key`).all<{ key: string }>()).results.map(r => r.key.slice('failing/119/'.length))
  const isWarm = async () => !!(await env.DB.prepare(`SELECT key FROM provider_cache WHERE provider = 'govinfo' AND key = 'warm/119'`).first())
  /** Every alert sent, as its recipients, subject, and text. */
  const alerts = () => mail.send.mock.calls.map(([m]: any[]) => ({ to: [m.to].flat(), subject: String(m.subject), text: String(m.text) }))
  /** The alerts that name a meeting. */
  const alertsNaming = (id: string) => alerts().filter(a => `${a.subject}\n${a.text}`.includes(id))

  /** A calendar with its first pass done, and what it shows of the meeting that will break, and of the bills it takes up. */
  async function established() {
    linkBills()
    await pass()
    const before = { upcoming: await eventOf(UPCOMING), markup: await eventOf(MARKUP), hb43: await billEntries('HB43'), hb131: await billEntries('HB131') }
    expect(before.hb43).toHaveLength(2)
    expect(before.hb131).toHaveLength(1)
    return before
  }
  /** UPCOMING's answer stops parsing (no date), and the list says it changed, so every pass reads it again. */
  let upcomingDate: string
  function breakUpcoming() {
    upcomingDate = feed.meetings.get(UPCOMING).date
    feed.edit(UPCOMING, m => { delete m.date })
  }
  /** Another meeting changes meanwhile, so a pass that finishes shows something new. */
  function retitleMarkup() {
    feed.edit(MARKUP, m => { m.title = 'A retitled markup' })
  }
  const passes = async (n: number) => {
    const out = []
    for (let i = 0; i < n; i++) out.push(await pass())
    return out
  }
  /** UPCOMING broken for QUARANTINE_AFTER passes, after checking the last of them finished with it quarantined. */
  async function quarantineUpcoming() {
    breakUpcoming()
    const last = (await passes(QUARANTINE_AFTER)).at(-1)!
    expect(last.reports[0]).toMatchObject({ failed: 0 })
    expect(await failing()).toEqual([UPCOMING])
  }

  it('still fails the pass closed, and alerts no one, on each pass short of QUARANTINE_AFTER', async () => {
    const before = await established()
    breakUpcoming()
    retitleMarkup()
    for (let i = 0; i < QUARANTINE_AFTER - 1; i++) {
      const { reports } = await pass()
      expect(reports[0]).toMatchObject({ months: 0, failed: 5 })
      expect(await eventOf(MARKUP)).toEqual(before.markup)
      expect(await billEntries('HB43')).toEqual(before.hb43)
    }
    expect(alerts()).toEqual([])
  })

  it('quarantines it on the QUARANTINE_AFTER-th failing pass: the rest of the calendar updates, and its own event and bill entries stay as they were', async () => {
    const before = await established()
    breakUpcoming()
    retitleMarkup()
    const reports = (await passes(QUARANTINE_AFTER)).map(p => p.reports[0])
    expect(reports.at(-1)).toMatchObject({ months: 5, failed: 0 })
    // The rest updates: the markup's new title, on the body calendar and on the bill it takes up.
    expect((await eventOf(MARKUP)).agenda[0].topic).toBe('A retitled markup')
    expect((await billEntries('HB43')).find((c: any) => c.date === '2026-09-15').description).toMatch(/A retitled markup/)
    // The quarantined meeting is as it was, everywhere.
    expect(await eventOf(UPCOMING)).toEqual(before.upcoming)
    expect(await billEntries('HB131')).toEqual(before.hb131)
    expect((await billEntries('HB43')).find((c: any) => c.date === '2026-10-23')).toEqual(before.hb43.find((c: any) => c.date === '2026-10-23'))
    expect(await failing()).toEqual([UPCOMING])
  })

  it('alerts once, naming the event id, and not again on the passes after', async () => {
    await established()
    breakUpcoming()
    await passes(QUARANTINE_AFTER)
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0].to).toEqual([ALERTS_TO])
    expect(alerts()[0].subject).toContain(UPCOMING)
    expect(alerts()[0].text).toContain(UPCOMING)
    await passes(2)
    expect(alerts()).toHaveLength(1)
  })

  it('asks for a quarantined meeting again on every pass', async () => {
    await established()
    await quarantineUpcoming()
    const asked = feed.detailIds.length
    await pass()
    expect(feed.detailIds.slice(asked)).toContain(UPCOMING)
  })

  it('releases a quarantined meeting once it parses, and updates it normally', async () => {
    await established()
    await quarantineUpcoming()
    feed.edit(UPCOMING, m => { m.date = upcomingDate; m.title = 'Back again' })
    const { reports } = await pass()
    expect(reports[0]).toMatchObject({ failed: 0 })
    expect((await eventOf(UPCOMING)).agenda[0].topic).toBe('Back again')
    expect((await billEntries('HB131')).map((c: any) => c.description)).toEqual([expect.stringMatching(/Back again/)])
    expect(await failing()).toEqual([])
  })

  it('counts from the start again for a released meeting that breaks again: one failure fails the pass closed', async () => {
    await established()
    await quarantineUpcoming()
    feed.edit(UPCOMING, m => { m.date = upcomingDate })
    await pass()
    feed.edit(UPCOMING, m => { delete m.date })
    retitleMarkup()
    const { reports } = await pass()
    expect(reports[0]).toMatchObject({ months: 0, failed: 5 })
  })

  it('counts a meeting\'s failing passes, and remembers its alert, in what it keeps, so a restart loses neither', async () => {
    await established()
    breakUpcoming()
    await passes(QUARANTINE_AFTER - 1)
    // Each pass is a new isolate (clearMeetingCaches): what it knows of the failures is in the cache.
    expect(await failing()).toEqual([UPCOMING])
    retitleMarkup()
    expect((await pass()).reports[0]).toMatchObject({ failed: 0 })
    expect(alerts()).toHaveLength(1)
    clearMeetingCaches()
    await passes(2)
    expect(alerts()).toHaveLength(1)
  })

  it('quarantines two meetings on the same passes, alerting once for each', async () => {
    const before = await established()
    breakUpcoming()
    feed.edit(HEARING, m => { m.committees = 'not a list' })
    retitleMarkup()
    const reports = (await passes(QUARANTINE_AFTER)).map(p => p.reports[0])
    expect(reports.at(-1)).toMatchObject({ months: 5, failed: 0 })
    expect((await eventOf(MARKUP)).agenda[0].topic).toBe('A retitled markup')
    expect(await eventOf(UPCOMING)).toEqual(before.upcoming)
    expect(await failing()).toEqual([HEARING, UPCOMING].sort())
    expect(alertsNaming(UPCOMING)).toHaveLength(1)
    expect(alertsNaming(HEARING)).toHaveLength(1)
    await pass()
    expect(alertsNaming(UPCOMING)).toHaveLength(1)
    expect(alertsNaming(HEARING)).toHaveLength(1)
  })

  it('quarantines nothing for an answer that isn\'t 200, which is the API failing and not the meeting: every pass fails closed', async () => {
    const before = await established()
    feed.edit(UPCOMING, m => { m.title = 'Changed' })
    retitleMarkup()
    feed.override.detail = id => (id === UPCOMING ? new Response('boom', { status: 500 }) : null)
    for (const { reports } of await passes(QUARANTINE_AFTER + 1)) expect(reports[0]).toMatchObject({ months: 0, failed: 5 })
    expect(await eventOf(MARKUP)).toEqual(before.markup)
    expect(await failing()).toEqual([])
    expect(alerts()).toEqual([])
  })

  it('forgets a quarantined meeting the list no longer names', async () => {
    await established()
    await quarantineUpcoming()
    feed.remove(UPCOMING)
    await pass()
    expect(await failing()).toEqual([])
  })

  describe('during the first fill, with a meeting never read', () => {
    /** More meetings than a pass reads, so the first passes leave the cache cold, and a broken one with the highest id, read first. */
    function coldWithABrokenMeeting() {
      for (let i = 0; i < 80; i++) feed.add(String(100000 + i), HEARING, m => { m.date = '2025-03-01T15:00:00Z' })
      feed.add('900020', HEARING, m => { m.date = '2026-11-18T15:00:00Z' })
      feed.edit('900020', m => { delete m.date })
    }

    it('shows nothing until it is quarantined, then fills the rest and goes warm without it', async () => {
      coldWithABrokenMeeting()
      linkBills()
      await passes(QUARANTINE_AFTER - 1)
      expect((await events()).events).toEqual([])
      expect(await isWarm()).toBe(false)
      // A failing pass still reads its share and stages it, so the pass that quarantines it finishes the first fill.
      await pass()
      expect((await events()).byUid.has(uid('900020'))).toBe(false)
      expect((await events()).events).toHaveLength(IN_WINDOW)
      expect(await isWarm()).toBe(true)
      // Warm: a bill's calendar has its meetings.
      expect((await billEntries('HB43')).map((c: any) => c.date)).toEqual(['2026-09-15', '2026-10-23'])
    })

    it('stays warm on the passes after, while the quarantined meeting still can\'t be read', async () => {
      coldWithABrokenMeeting()
      await passes(QUARANTINE_AFTER + 1)
      expect(await isWarm()).toBe(true)
      await passes(2)
      expect(await isWarm()).toBe(true)
      expect(await failing()).toEqual(['900020'])
      expect(alertsNaming('900020')).toHaveLength(1)
    })
  })
})

describe('what the list does while it is read', () => {
  it('asks, after its pages, for the meetings changed since just before the read began', async () => {
    await syncCalendar()
    expect(feed.recentRequests).toHaveLength(1)
    const p = new URL(feed.recentRequests[0].url).searchParams
    // The clock is frozen at 13:00 UTC, and the margin is ten minutes.
    expect(p.get('fromDateTime')).toBe('2026-10-17T12:50:00Z')
    expect(p.get('limit')).toBe('250')
    expect(p.get('offset')).toBe('0')
    const rows = await logged()
    expect(rows.filter(r => r.callType === 'govinfo:CongressMeetingList').length).toBe(feed.listRequests.length + 1)
  })

  it('finds a meeting that moved up the list from a page not yet read, and so does not fail', async () => {
    for (let i = 0; i < 300; i++) feed.add(String(100000 + i), HEARING, m => { m.date = '2025-03-01T15:00:00Z' })
    // The list is 250 a page, newest update first. A meeting on the second page is changed after the first is read.
    let changed = false
    feed.override.list = offset => {
      if (offset === 250 && !changed) {
        changed = true
        feed.edit(HEARING, m => { m.title = 'Retitled while the list was read' })
      }
      return null
    }
    await syncCalendar()
    expect(changed).toBe(true)
    // The pass finished, and shows the meeting as changed.
    expect((await events()).events).toHaveLength(IN_WINDOW)
    expect((await eventOf(HEARING)).agenda[0].topic).toBe('Retitled while the list was read')
  })

  it('finds a meeting added while it is read', async () => {
    for (let i = 0; i < 300; i++) feed.add(String(500000 + i), HEARING, m => { m.date = '2025-03-01T15:00:00Z' })
    let added = false
    feed.override.list = offset => {
      if (offset === 250 && !added) {
        added = true
        feed.add('900200', HEARING, m => { m.date = '2026-11-18T15:00:00Z' })
      }
      return null
    }
    await syncCalendar()
    expect(added).toBe(true)
    expect((await eventOf('900200'))).toMatchObject({ date: '2026-11-18' })
  })
})

describe('while the meetings are still being read for the first time', () => {
  const isWarm = async () => !!(await env.DB.prepare(`SELECT key FROM provider_cache WHERE provider = 'govinfo' AND key = 'warm/119'`).first())
  /** More new meetings than a pass reads, all with higher event ids than the recorded ones, so they are read first. */
  function newerThanAPass() {
    for (let i = 0; i < DETAILS_PER_PASS + 5; i++) feed.add(String(200000 + i), HEARING, m => { m.date = '2025-03-01T15:00:00Z' })
  }

  it('goes cold again when a kept meeting can no longer be read and this pass has no request left for it', async () => {
    linkBills()
    await pass()
    expect(await isWarm()).toBe(true)
    newerThanAPass()
    await env.DB.prepare(`UPDATE provider_cache SET value = 'not json' WHERE key = ?`).bind(`meeting/119/${UPCOMING}`).run()
    const before = feed.detailIds.length
    await pass()
    // The lost meeting waits behind the new ones, so a bill's calendar can't yet say it has none.
    expect(feed.detailIds.slice(before)).not.toContain(UPCOMING)
    expect(await isWarm()).toBe(false)
  })

  it('stays warm while only new meetings wait to be read', async () => {
    linkBills()
    await pass()
    newerThanAPass()
    await pass()
    expect(await isWarm()).toBe(true)
  })

  it('is not warm after a pass whose list named no meeting', async () => {
    for (const id of [...feed.meetings.keys()]) feed.remove(id)
    await syncCalendar()
    expect(await isWarm()).toBe(false)
  })

  /** More meetings than a pass reads, so the first passes leave the cache cold: 22 recorded and this many at 60 a pass. */
  function overfill(n = 80) {
    for (let i = 0; i < n; i++) feed.add(String(100000 + i), HEARING, m => { m.date = '2025-03-01T15:00:00Z' })
  }
  const rowsOf = async (number: string) => db().select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, await billId(number))).all()

  /** A live calendar entry the bill already has, from an earlier ingest by this provider. */
  async function preset() {
    await db().insert(schema.billCalendar).values({
      id: 'earlier-entry', billId: await billId('HB43'), typeId: 1, type: 'Hearing', date: '2026-08-01', time: '10:00', location: '',
      description: 'An earlier hearing', eventId: '555555', identityKey: 'id:555555', eventHash: 'earlier', missedPulls: 0, cancelledAt: null,
    })
  }

  it('says nothing of a bill\'s calendar until every meeting has been read once, so no entry is counted missing', async () => {
    overfill(130)
    linkBills()
    await preset()
    await pass()
    // The first pass read 60 of 152 meetings: the cache is cold.
    expect(feed.detailIds).toHaveLength(DETAILS_PER_PASS)
    await seam.ingest(await billId('HB43'))
    await pass()
    await seam.ingest(await billId('HB43'))
    // Two passes read 120, and the third will finish. Until then no pull of the bill counted its entry missing.
    expect(feed.detailIds.length).toBe(2 * DETAILS_PER_PASS)
    expect((await rowsOf('HB43')).find(r => r.id === 'earlier-entry')).toMatchObject({ missedPulls: 0, cancelledAt: null })
    await pass()
    expect(feed.detailIds.length).toBe(feed.meetings.size)
    expect((await rowsOf('HB43')).find(r => r.id === 'earlier-entry')).toMatchObject({ missedPulls: 1, cancelledAt: null })
  })

  it('shows no meeting on a bill while it is cold, and all of them once it is warm, counting the missing entry then', async () => {
    overfill()
    linkBills()
    await preset()
    await pass()
    expect((await rowsOf('HB43')).filter(r => r.eventId !== '555555')).toEqual([])
    expect(await billEntries('HB43')).toHaveLength(1)
    await pass()
    // Warm: the record carries its meetings, the bill was ingested again, and the earlier entry is missed once.
    expect((await billEntries('HB43')).map((c: any) => c.date)).toEqual(['2026-08-01', '2026-09-15', '2026-10-23'])
    expect((await rowsOf('HB43')).find(r => r.id === 'earlier-entry')).toMatchObject({ missedPulls: 1, cancelledAt: null })
  })

  it('leaves a cut-over bill\'s carried calendar alone while it is cold, and pairs it once it is warm', async () => {
    overfill()
    linkBills()
    const hb43 = await billId('HB43')
    // A bill a cutover moved here from LegiScan, with the LegiScan hearing instances know under LegiScan's identity.
    await db().update(schema.bills).set({ carriedFrom: 'legiscan', carriedWaits: null }).where(eq(schema.bills.billId, hb43))
    await db().insert(schema.billCalendar).values({
      id: 'carried-hearing', billId: hb43, typeId: 1, type: 'Hearing', date: '2026-10-23', time: '10:00', location: '',
      description: 'Hearing on H.R. 43', eventId: null, identityKey: '1|hearing on h.r. 43', eventHash: 'ls', missedPulls: 0, cancelledAt: null,
    })
    await pass()
    await seam.ingest(hb43)
    const held = (await rowsOf('HB43')).find(r => r.id === 'carried-hearing')
    // Still waiting for a calendar to carry it to: not cancelled, not carried.
    expect(held).toMatchObject({ cancelledAt: null, identityKey: '1|hearing on h.r. 43' })
    expect((await db().select().from(schema.bills).where(eq(schema.bills.billId, hb43)).get())?.carriedFrom).toBe('legiscan')

    await pass()
    await seam.ingest(hb43)
    const carried = (await rowsOf('HB43')).find(r => r.id === 'carried-hearing')
    // Warm: the October 23 hearing pairs with the meeting that day and keeps the identity instances have.
    expect(carried).toMatchObject({ cancelledAt: null, identityKey: '1|hearing on h.r. 43', eventId: '119583', date: '2026-10-23' })
    expect((await db().select().from(schema.bills).where(eq(schema.bills.billId, hb43)).get())?.carriedFrom).toBeNull()
  })

  it('counts no missed pull against a live entry of the provider\'s own while it is cold', async () => {
    overfill()
    linkBills()
    await pass()
    await seam.ingest(await billId('HB43'))
    // Cold, so no entries yet, and a second cold ingest changes nothing.
    await db().insert(schema.billCalendar).values({
      id: 'live', billId: await billId('SB296'), typeId: 1, type: 'Hearing', date: '2026-10-06', time: '09:00', location: '', description: 'x',
      eventId: '119575', identityKey: 'id:119575', eventHash: 'h', missedPulls: 0, cancelledAt: null,
    })
    await seam.ingest(await billId('SB296'))
    expect((await rowsOf('SB296')).find(r => r.id === 'live')).toMatchObject({ missedPulls: 0, cancelledAt: null })
  })

  it('has no bill carry an empty calendar before the first full read, then an empty one for a bill with no meeting', async () => {
    overfill()
    linkBills()
    await pass()
    // Cold: no record has meetings, not even an empty list.
    const cold = await env.DB.prepare(`SELECT raw_json AS raw FROM provider_records WHERE provider = 'govinfo'`).all<{ raw: string }>()
    expect(cold.results.length).toBeGreaterThan(20)
    expect(cold.results.filter(r => 'meetings' in JSON.parse(r.raw))).toEqual([])
    await pass()
    const warm = await env.DB.prepare(`SELECT raw_json AS raw FROM provider_records WHERE provider = 'govinfo'`).all<{ raw: string }>()
    // Warm: every record has them, the bills with no meeting an empty list.
    expect(warm.results.every(r => Array.isArray(JSON.parse(r.raw).meetings))).toBe(true)
    expect(warm.results.filter(r => JSON.parse(r.raw).meetings.length > 0).length).toBe(3)
  })
})

describe('across the change of Congress', () => {
  it('keeps serving the earlier Congress\'s meetings for the months before the new one begins, so December\'s held meetings are never cancelled', async () => {
    vi.setSystemTime(new Date('2026-12-20T13:00:00Z'))
    feed.add('900100', HEARING, m => { m.date = '2026-12-09T15:00:00Z' })
    await syncCalendar()
    expect((await eventOf('900100'))).toMatchObject({ date: '2026-12-09', cancelled: false })

    // January 20, 2027: the 120th Congress, which lists one meeting, in January.
    vi.setSystemTime(new Date('2027-01-20T13:00:00Z'))
    feed.add('990001', HEARING, m => { m.congress = 120; m.date = '2027-01-14T15:00:00Z' })
    const run = makeRun()
    for (let i = 0; i < 26; i++) {
      clearMeetingCaches()
      await runBodyEventSync(govinfo, run.env as any, db())
    }
    const body = await getJson('/tenants/usteam/body-events?from=2026-11-01&to=2027-03-31')
    const byUid = new Map<string, any>(body.events.map((e: any) => [e.uid, e]))
    expect(byUid.get(uid('990001'))).toMatchObject({ date: '2027-01-14', cancelled: false })
    // Every 119th meeting of November and December is still live a day on, and more.
    expect(byUid.get(uid('900100'))).toMatchObject({ date: '2026-12-09', cancelled: false })
    expect([...byUid.values()].filter(e => e.date >= '2026-11-01' && e.date < '2027-01-03' && e.cancelled)).toEqual([])
    expect([...byUid.values()].filter(e => e.date >= '2026-11-01' && e.date < '2027-01-03').length).toBeGreaterThan(0)
  })

  it('asks the API for the new Congress only, and serves the earlier one from what it kept', async () => {
    vi.setSystemTime(new Date('2026-12-20T13:00:00Z'))
    feed.add('900100', HEARING, m => { m.date = '2026-12-09T15:00:00Z' })
    await syncCalendar()
    vi.setSystemTime(new Date('2027-01-20T13:00:00Z'))
    feed.requests.length = 0
    await syncCalendar()
    expect(feed.requests.length).toBeGreaterThan(0)
    expect(feed.requests.every(r => r.url.includes('/committee-meeting/120'))).toBe(true)
    expect(feed.detailRequests).toEqual([])
    // The December meetings the earlier Congress held are still served, from what was kept.
    const ctx = providerContext(govinfo, makeRun().env as any, db())
    const december = await govinfo.listBodyEvents!('US', { from: '2026-12-01', to: '2026-12-31' }, ctx)
    expect(december.length).toBeGreaterThan(0)
    expect(feed.requests.every(r => r.url.includes('/committee-meeting/120'))).toBe(true)
  })

  it('keeps the earlier Congress\'s kept meetings, which the window still needs', async () => {
    vi.setSystemTime(new Date('2026-12-20T13:00:00Z'))
    await syncCalendar()
    vi.setSystemTime(new Date('2027-01-20T13:00:00Z'))
    await syncCalendar()
    const kept = await env.DB.prepare(`SELECT key FROM provider_cache WHERE key LIKE 'meeting/119/%'`).all()
    expect(kept.results.length).toBe(feed.meetings.size)
  })

  it('serves nothing of the earlier Congress for a month after the new one began', async () => {
    vi.setSystemTime(new Date('2026-12-20T13:00:00Z'))
    // A meeting the 119th Congress lists, dated after it ends, which the 120th doesn't hold.
    feed.add('900102', HEARING, m => { m.date = '2027-02-10T15:00:00Z' })
    await syncCalendar()
    expect((await getJson('/tenants/usteam/body-events?from=2027-02-01&to=2027-02-28')).events.map((e: any) => e.uid)).toEqual([uid('900102')])
    vi.setSystemTime(new Date('2027-01-20T13:00:00Z'))
    const ctx = providerContext(govinfo, makeRun().env as any, db())
    clearMeetingCaches()
    const feb = await govinfo.listBodyEvents!('US', { from: '2027-02-01', to: '2027-02-28' }, ctx)
    expect(feb).toEqual([])
    // January 1 and 2 are the earlier Congress's still: it ends at noon on the 3rd.
    feed.add('900101', HEARING, m => { m.date = '2027-01-02T15:00:00Z' })
    vi.setSystemTime(new Date('2026-12-21T13:00:00Z'))
    await syncCalendar()
    vi.setSystemTime(new Date('2027-01-20T13:00:00Z'))
    clearMeetingCaches()
    const jan = await govinfo.listBodyEvents!('US', { from: '2027-01-01', to: '2027-01-31' }, ctx)
    expect(jan.map(e => e.event_id)).toEqual(['900101'])
  })
})

describe('a bill that is not a bill of its own file', () => {
  it('fails a meeting that names a bill of a type Congress doesn\'t have, naming the type', async () => {
    feed.edit(UPCOMING, m => { m.relatedItems = { bills: [{ congress: 119, number: '1', type: 'HAMDT', url: 'x' }] } })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await syncCalendar()
    expect(consoleText([errors])).toMatch(/HAMDT/)
    expect((await events()).events).toEqual([])
  })
})
