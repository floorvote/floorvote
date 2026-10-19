import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { asc, eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'

// Bill detail from GovInfo Bill Status at the main seam (#617): a tracked
// bill's own file is downloaded again at ingest, and central's bill API serves
// its history, sponsors, texts, committees, subjects, related bills, and
// extras. Recorded real Bill Status files go in, with the network stubbed at
// fetch, and the bill API (plus the tables an ingest writes) comes out.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { govinfo } from '../../src/providers/govinfo'
import { clearRollCallCaches } from '../../src/providers/govinfo/client'
import { rollCallNetwork } from '../helpers/govinfoRollCalls'
import { toHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral } from '../helpers/mainSeam'
import { BILL_TYPES, buildZip, fileType, fixtureFiles, LISTING_URL, listingResponse, serveZip } from '../helpers/govinfoZip'
import { parseXml } from '../../src/providers/govinfo/xml'
import { xmlObject } from '../helpers/xmlObject'

const ZIP_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/BILLSTATUS-\d+-([a-z]+)\.zip$/
const FILE_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/(BILLSTATUS-\d+[a-z]+\d+\.xml)$/
const PDF_URL = /^https:\/\/www\.govinfo\.gov\/content\/pkg\/([A-Za-z0-9-]+)\/pdf\/\1\.pdf$/
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const pdfUrl = (pkg: string) => `https://www.govinfo.gov/content/pkg/${pkg}/pdf/${pkg}.pdf`
const fileUrl = (name: string) => {
  const m = /^BILLSTATUS-(\d+)([a-z]+)\d+\.xml$/.exec(name)!
  return `https://www.govinfo.gov/bulkdata/BILLSTATUS/${m[1]}/${m[2]}/${name}`
}

/** The Bill Status files the stubbed GovInfo serves, by file name. A test replaces entries to change a bill. */
let files: Map<string, string>
/** What the stubbed GovInfo answers for a bill's own file, by file name, in place of the file. */
let fileAnswers: Map<string, () => Response>
/** The package ids whose PDFs the stubbed GovInfo doesn't have. */
let missingPdfs: Set<string>
let calls: { method: string; url: string; accept: string | null }[]

const seam = mainSeam(govinfo, { tenantId: 'usteam' })
const { makeRun, getJson, sync, syncAndIngest, queuedIds } = seam
const billId = (number: string) => seam.billIdOf(number)
const bill = async (number: string) => getJson(`/bills/${toHandle(await billId(number))}`)
const db = () => drizzle(env.DB, { schema })

const file = (name: string) => `BILLSTATUS-119${name}.xml`
const xml = (name: string) => fixtureFiles.get(file(name))!
/** A recorded file with a change made to its text. The change must apply, or the test is testing nothing. */
const edit = (name: string, change: (x: string) => string) => {
  const before = xml(name)
  const after = change(before)
  expect(after, `the edit to ${name} changed nothing`).not.toBe(before)
  files.set(file(name), after)
}
const obj = (name: string): any => xmlObject(parseXml(xml(name)).root)
const arr = (v: unknown): any[] => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v])

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** The zip of one type, which the sync reads. Every bill's detail comes from its own file, not the zip. */
function serveZips() {
  return (type: string) => serveZip(buildZip(
    [...files].filter(([name]) => fileType(name) === type).map(([name, data]) => ({ name, data })),
  ), { headers: { 'last-modified': 'Sat, 17 Oct 2026 00:19:30 GMT' } }).response
}

/** The recorded roll call and member files the stubbed network serves, for the bills that link votes (#618). */
let rollNet: Map<string, () => Response>

beforeEach(async () => {
  await resetCentral()
  clearRollCallCaches()
  rollNet = rollCallNetwork()
  files = new Map(fixtureFiles)
  fileAnswers = new Map()
  missingPdfs = new Set()
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ method: init?.method ?? 'GET', url, accept: new Headers(init?.headers).get('Accept') })
    const zip = ZIP_URL.exec(url)
    if (zip && zip[2] === zip[3]) return serveZips()(zip[2])
    // Every file listed as it was when the zips, built from the same files, were built (#616).
    const listing = listingResponse(url, files, () => '2026-07-18T23:27:00Z')
    if (listing) return listing
    const f = FILE_URL.exec(url)
    if (f) {
      const answer = fileAnswers.get(f[3])
      if (answer) return answer()
      const data = files.get(f[3])
      return data === undefined ? new Response('not found', { status: 404 }) : new Response(data, { headers: { 'content-type': 'application/xml' } })
    }
    const p = PDF_URL.exec(url)
    if (p) return missingPdfs.has(p[1]) ? new Response('not found', { status: 404 }) : new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    const roll = rollNet.get(url)
    if (roll) return roll()
    return new Response('not found', { status: 404 })
  })
  await seam.addTenant('US', ['choice for veterans'])
  await seam.claim('US', 'govinfo')
})

afterEach(() => {
  vi.useRealTimers()
})

/** Sync Congress, then ingest the bills with these numbers. The instance's one keyword matches only the CHOICE for Veterans Act. */
async function ingest(...numbers: string[]) {
  await sync()
  const messages = await seam.ingest(await Promise.all(numbers.map(billId)))
  for (const m of messages) expect(m.retry, JSON.stringify(m.body)).not.toHaveBeenCalled()
  return messages
}

/** The same, for a test of an ingest failing closed: the message must be retried. */
async function ingestFailing(...numbers: string[]) {
  await sync()
  const messages = await seam.ingest(await Promise.all(numbers.map(billId)))
  for (const m of messages) expect(m.retry, 'the ingest should be retried').toHaveBeenCalled()
}

/** Every table an ingest writes a bill's detail to, for the bills in them. */
async function detailRows() {
  const d = db()
  return {
    history: await d.select().from(schema.billHistory).all(),
    sponsors: await d.select().from(schema.billSponsors).all(),
    people: await d.select().from(schema.people).all(),
    texts: await d.select().from(schema.billTexts).all(),
    sasts: await d.select().from(schema.billSasts).all(),
    subjects: await d.select().from(schema.billSubjects).all(),
    referrals: await d.select().from(schema.billReferrals).all(),
    committees: await d.select().from(schema.committees).all(),
    extras: await d.select().from(schema.billExtras).all(),
  }
}

async function nothingWritten() {
  const rows = await detailRows()
  for (const [table, list] of Object.entries(rows)) expect(list, table).toEqual([])
  expect(await db().select().from(schema.rollCalls).all()).toEqual([])
}

describe('a tracked bill\'s file', () => {
  it('is downloaded once at ingest, by its own address, and not the zip again', async () => {
    await ingest('HB3132')
    const detail = calls.filter(c => !ZIP_URL.test(c.url) && !LISTING_URL.test(c.url) && !PDF_URL.test(c.url))
    expect(detail).toEqual([{
      method: 'GET',
      url: 'https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr3132.xml',
      accept: expect.stringContaining('xml'),
    }])
    // The zips were read once each, by the sync.
    expect(calls.filter(c => ZIP_URL.test(c.url))).toHaveLength(BILL_TYPES.length)
  })

  it('is asked for by the Congress, type, and number of the bill: a Senate joint resolution\'s too', async () => {
    await ingest('SJR133')
    expect(calls.map(c => c.url)).toContain('https://www.govinfo.gov/bulkdata/BILLSTATUS/119/sjres/BILLSTATUS-119sjres133.xml')
  })
})

describe('history', () => {
  it('serves actions oldest first, with the Library of Congress\'s duplicate "Introduced" action dropped', async () => {
    await ingest('HB837')
    const { actions } = await bill('HB837')
    const feed = arr(obj('hr837').bill.actions.item)
    // The feed lists the newest first, and lists "Introduced in House" twice, as codes 1000 and Intro-H.
    expect(feed.filter((a: any) => a.text === 'Introduced in House')).toHaveLength(2)
    expect(actions).toHaveLength(feed.length - 1)
    expect(actions.filter((a: any) => a.description === 'Introduced in House')).toHaveLength(1)
    expect(actions[0]).toMatchObject({ description: 'Introduced in House', date: '2025-01-31' })
    expect(actions.at(-1)).toMatchObject({ description: 'Presented to President.', date: '2026-10-15' })
    const dates = actions.map((a: any) => a.date)
    expect(dates).toEqual([...dates].sort())
    expect(actions.map((a: any) => a.order)).toEqual(actions.map((_: unknown, i: number) => i))
  })

  it('keeps every other action the feed lists, including its own duplicates, in the feed\'s order within a day', async () => {
    await ingest('HB837')
    const { actions } = await bill('HB837')
    // 2025-02-05 has six House floor actions the feed lists newest first by time, so the page lists them oldest first.
    expect(actions.filter((a: any) => a.date === '2025-02-05').map((a: any) => a.description.slice(0, 40))).toEqual([
      'Mr. Westerman moved to suspend the rules',
      'Considered under suspension of the rules.',
      'DEBATE - The House proceeded with forty m',
      'Passed/agreed to in House: On motion to s',
      'On motion to suspend the rules and pass t',
      'Motion to reconsider laid on the table Ag',
    ].map(s => expect.stringContaining(s.slice(0, 20))))
  })

  it('drops the Library of Congress\'s older introduction action even when it has no text, as many Senate bills\' do', async () => {
    edit('s296', x => x.replace('<actions>', `<actions>
      <item>
        <actionDate>2025-01-29</actionDate>
        <type>IntroReferral</type>
        <actionCode>Intro-S</actionCode>
        <sourceSystem><code>9</code><name>Library of Congress</name></sourceSystem>
      </item>`))
    await ingest('SB296')
    const { actions } = await bill('SB296')
    expect(actions).toHaveLength(arr(obj('s296').bill.actions.item).length)
    expect(actions.filter((a: any) => /^Introduced in Senate/.test(a.description))).toHaveLength(1)
  })

  it('keeps one when the Library of Congress introduces a bill twice over, as it does for a few', async () => {
    edit('hr837', x => x.replace(/(<item>\s*<actionDate>2025-01-31<\/actionDate>\s*<text>Introduced in House<\/text>\s*<type>IntroReferral<\/type>\s*<actionCode>1000<\/actionCode>[\s\S]*?<\/item>)/, '$1$1'))
    await ingest('HB837')
    expect((await bill('HB837')).actions.filter((a: any) => a.description === 'Introduced in House')).toHaveLength(1)
  })

  it('keeps the single "Introduced" action of a Senate bill', async () => {
    await ingest('SB296')
    const { actions } = await bill('SB296')
    expect(actions.filter((a: any) => /^Introduced in Senate/.test(a.description))).toHaveLength(1)
    expect(actions).toHaveLength(arr(obj('s296').bill.actions.item).length)
  })

  it('puts a feed that isn\'t newest first in date order too', async () => {
    // The oldest action moved to the front of the feed.
    edit('hr3132', x => {
      const items = [...x.matchAll(/\n      <item>\n        <actionDate>[\s\S]*?\n      <\/item>/g)].map(m => m[0])
      const open = x.indexOf('<actions>') + '<actions>'.length
      const close = x.indexOf('</actions>')
      const shuffled = [items.at(-1)!, ...items.slice(0, -1)]
      return x.slice(0, open) + shuffled.join('') + '\n    ' + x.slice(close)
    })
    await ingest('HB3132')
    const dates = (await bill('HB3132')).actions.map((a: any) => a.date)
    // Five actions in the feed, two of them the Library of Congress's "Introduced in House".
    const feed = arr(obj('hr3132').bill.actions.item)
    expect(feed.filter((a: any) => a.text === 'Introduced in House')).toHaveLength(2)
    expect(dates).toHaveLength(feed.length - 1)
    expect(dates).toEqual([...dates].sort())
  })

  it('takes each action\'s chamber from its source system: House floor and committee, Senate, and none for the Library of Congress', async () => {
    await ingest('HB837', 'HB131')
    const { actions } = await bill('HB837')
    const chamberOf = (text: string) => {
      const action = actions.find((a: any) => a.description.startsWith(text))
      expect(action, text).toBeDefined()
      return action.chamber
    }
    expect(chamberOf('Mr. Westerman moved')).toBe('H') // House floor actions
    expect(chamberOf('Committee on Energy and Natural Resources. Ordered')).toBe('S')
    expect(chamberOf('Placed on Senate Legislative Calendar')).toBe('S')
    expect(chamberOf('Passed/agreed to in Senate')).toBeNull() // Library of Congress
    expect(chamberOf('Introduced in House')).toBeNull()
    // Congress's House committee actions are the House's.
    const committeeAction = (await bill('HB131')).actions
    expect(committeeAction.some((a: any) => a.chamber === 'H')).toBe(true)
  })

  it('stores importance 1 for Floor, President, BecameLaw, and Veto actions, and 2 for the rest', async () => {
    await ingest('HB43', 'HB131')
    const rows = await db().select().from(schema.billHistory).orderBy(asc(schema.billHistory.billId), asc(schema.billHistory.seq)).all()
    const byAction = (id: number) => rows.filter(r => r.billId === id)
    const hb43 = byAction(await billId('HB43'))
    const feed43 = arr(obj('hr43').bill.actions.item)
    expect(feed43.filter((a: any) => a.type === 'BecameLaw')).not.toEqual([])
    expect(hb43.find(r => r.action === 'Became Public Law No: 119-23.')!.importance).toBe(1)
    expect(hb43.find(r => r.action === 'Presented to President.')!.importance).toBe(1)
    expect(hb43.find(r => r.action === 'Introduced in House')!.importance).toBe(2)
    expect(hb43.find(r => r.action.startsWith('Referred to the House Committee'))!.importance).toBe(2)
    expect(hb43.find(r => r.action.startsWith('Passed/agreed to in House'))!.importance).toBe(1)
    // A veto.
    const hb131 = byAction(await billId('HB131'))
    const vetoes = arr(obj('hr131').bill.actions.item).filter((a: any) => a.type === 'Veto')
    expect(vetoes.length).toBeGreaterThan(0)
    for (const v of vetoes) expect(hb131.find(r => r.action === v.text && r.date === v.actionDate)!.importance).toBe(1)
    // Every other type is 2.
    const important = new Set(['Floor', 'President', 'BecameLaw', 'Veto'])
    for (const [name, id] of [['hr43', await billId('HB43')], ['hr131', hb131[0].billId]] as const) {
      const types = new Map<string, string>(arr(obj(name).bill.actions.item).map((a: any) => [`${a.actionDate}|${a.text}`, a.type]))
      for (const r of byAction(id)) expect(r.importance, r.action).toBe(important.has(types.get(`${r.date}|${r.action}`)!) ? 1 : 2)
    }
  })

  it('serves a bill with no actions at all an empty history', async () => {
    await ingest('HB2')
    expect((await bill('HB2')).actions).toEqual([])
  })
})

describe('sponsors', () => {
  it('serves the sponsor first, as primary, then every cosponsor in the feed\'s order', async () => {
    await ingest('HB3132')
    const { sponsors } = await bill('HB3132')
    const feed = obj('hr3132').bill
    const cosponsors = arr(feed.cosponsors.item)
    expect(cosponsors).toHaveLength(60)
    expect(sponsors).toHaveLength(61)
    expect(sponsors[0]).toMatchObject({ name: 'Jack Bergman', primary: true, party: 'R', role: 'Rep' })
    expect(sponsors.slice(1).every((s: any) => s.primary === false)).toBe(true)
    // Each person's name, from the feed's first, middle, and last names.
    const named = (p: any) => [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ')
    expect(sponsors.map((s: any) => s.name)).toEqual([named(feed.sponsors.item[0]), ...cosponsors.map(named)])
  })

  it('gives each sponsor and cosponsor a Bioguide id, in the feed\'s order, and mints the person id from it', async () => {
    await ingest('HB3132')
    const feed = obj('hr3132').bill
    const expected = [feed.sponsors.item[0].bioguideId, ...arr(feed.cosponsors.item).map((c: any) => c.bioguideId)]
    const rows = await db().select().from(schema.billSponsors).where(eq(schema.billSponsors.billId, await billId('HB3132'))).orderBy(asc(schema.billSponsors.sponsorOrder)).all()
    expect(rows.map(r => r.sponsorTypeId)).toEqual([1, ...Array(60).fill(2)])
    expect(rows.map(r => r.sponsorOrder)).toEqual(rows.map((_, i) => i + 1))
    const people = new Map((await db().select().from(schema.people).all()).map(p => [p.peopleId, p]))
    expect(rows.map(r => people.get(r.peopleId!)!.bioguideId)).toEqual(expected)
    // The id is minted from the Bioguide id, so the same member is the same person on every bill.
    const minted = await db().select().from(schema.providerIds).where(eq(schema.providerIds.kind, 'person')).all()
    expect(new Map(minted.map(m => [m.nativeKey, m.id]))).toEqual(new Map(expected.map((b: string) => [b, rows[expected.indexOf(b)].peopleId])))
    for (const p of people.values()) expect(p.provider).toBe('govinfo')
  })

  it('names one person once however many bills they sponsor', async () => {
    // The same sponsor on a second bill.
    edit('hr7895', x => x.replace(/<sponsors>[\s\S]*?<\/sponsors>/, xml('hr3132').match(/<sponsors>[\s\S]*?<\/sponsors>/)![0]))
    await ingest('HB3132', 'HB7895')
    const a = (await bill('HB3132')).sponsors[0]
    const b = (await bill('HB7895')).sponsors[0]
    expect(a?.personId).toBeTruthy()
    expect(a.personId).toBe(b.personId)
    expect((await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'B001301')).all())).toHaveLength(1)
  })

  it('records each person\'s party, role, and district: a House member\'s as state and number', async () => {
    await ingest('HB3132')
    const bergman = (await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'B001301')).all())[0]
    expect(bergman).toMatchObject({
      name: 'Jack Bergman', firstName: 'Jack', lastName: 'Bergman', party: 'R', role: 'Rep', roleId: 1,
      district: 'MI-1', stateId: 52, bioguideId: 'B001301',
    })
  })

  it('records a senator with the role Sen, and their state as the district', async () => {
    await ingest('SB2503')
    const sponsor = obj('s2503').bill.sponsors.item[0]
    const row = (await db().select().from(schema.people).where(eq(schema.people.bioguideId, sponsor.bioguideId)).all())[0]
    expect(row).toMatchObject({ role: 'Sen', roleId: 2, party: sponsor.party, district: sponsor.state })
    expect((await bill('SB2503')).sponsors[0]).toMatchObject({ role: 'Sen', primary: true })
  })

  it.each([
    ['Del.', 'Del'],
    ['Rescom.', 'Del'],
  ])('reads %s as the role %s, in the House', async (prefix, role) => {
    edit('hr7895', x => x.replace(/<fullName>Rep\./, `<fullName>${prefix}`))
    await ingest('HB7895')
    const bioguide = obj('hr7895').bill.sponsors.item[0].bioguideId
    expect((await db().select().from(schema.people).where(eq(schema.people.bioguideId, bioguide)).all())[0]).toMatchObject({ role, roleId: 1 })
  })

  it('gives an at-large House member no number: their district is their state\'s at-large seat', async () => {
    edit('hr7895', x => x.replace(/(<sponsors>[\s\S]*?)\s*<district>\d+<\/district>/, '$1'))
    await ingest('HB7895')
    const s = obj('hr7895').bill.sponsors.item[0]
    const rows = await db().select().from(schema.people).where(eq(schema.people.bioguideId, s.bioguideId)).all()
    expect(rows.map(r => r.district)).toEqual([`${s.state}-AL`])
  })

  it('writes the real at-large members, whom the feed gives district 0, as the at-large seat of their state', async () => {
    // HR 6222's cosponsors include the delegate of the District of Columbia and the Representative of Delaware.
    expect(arr(obj('hr6222').bill.cosponsors.item).filter((c: any) => c.district === '0').map((c: any) => c.state).sort()).toEqual(['DC', 'DE'])
    await ingest('HB6222')
    const districts = (await db().select().from(schema.people).all()).map(p => p.district)
    expect(districts).toContain('DE-AL')
    expect(districts).toContain('DC-AL')
    expect(districts.filter(d => /-0$/.test(d ?? ''))).toEqual([])
  })

  it('serves a bill with no cosponsors its sponsor alone', async () => {
    expect(obj('hr7895').bill.cosponsors).toBeUndefined()
    await ingest('HB7895')
    expect((await bill('HB7895')).sponsors).toHaveLength(1)
  })

  it('leaves a withdrawn cosponsor out', async () => {
    const feed = obj('hr361').bill
    const withdrawn = arr(feed.cosponsors.item).filter((c: any) => c.sponsorshipWithdrawnDate)
    expect(withdrawn.map((c: any) => c.bioguideId)).toEqual(['D000628'])
    await ingest('HB361')
    const { sponsors } = await bill('HB361')
    expect(sponsors).toHaveLength(1 + arr(feed.cosponsors.item).length - 1)
    expect(sponsors.map((s: any) => s.name)).not.toContain('Neal P. Dunn')
    expect(await db().select().from(schema.people).where(eq(schema.people.bioguideId, 'D000628')).all()).toEqual([])
    // The cosponsors left, in the feed's order.
    const kept = arr(feed.cosponsors.item).filter((c: any) => !c.sponsorshipWithdrawnDate).map((c: any) => c.bioguideId)
    const rows = await db().select().from(schema.billSponsors).orderBy(asc(schema.billSponsors.sponsorOrder)).all()
    const people = new Map((await db().select().from(schema.people).all()).map(p => [p.peopleId, p.bioguideId]))
    expect(rows.slice(1).map(r => people.get(r.peopleId!))).toEqual(kept)
  })

  it('replaces the sponsors when a cosponsor withdraws, on the next ingest', async () => {
    await ingest('HB3132')
    expect((await bill('HB3132')).sponsors).toHaveLength(61)
    edit('hr3132', x => x.replace(/(<cosponsors>\s*<item>[\s\S]*?<isOriginalCosponsor>[^<]*<\/isOriginalCosponsor>)/, '$1<sponsorshipWithdrawnDate>2025-06-01</sponsorshipWithdrawnDate>'))
    await ingest('HB3132')
    expect((await bill('HB3132')).sponsors).toHaveLength(60)
  })
})

describe('texts', () => {
  it('serves one text for each text version, with the GovInfo PDF as its link', async () => {
    await ingest('HB10167')
    const { texts } = await bill('HB10167')
    expect(texts).toHaveLength(4)
    const byNote = Object.fromEntries(texts.map((t: any) => [t.note, t]))
    expect(Object.keys(byNote).sort()).toEqual(['Engrossed', 'Enrolled', 'Introduced', 'Referred in Senate'])
    expect(byNote.Introduced).toMatchObject({ date: '2026-08-27', links: [{ url: pdfUrl('BILLS-119hr10167ih'), mediaType: 'application/pdf' }] })
    expect(byNote.Engrossed).toMatchObject({ date: '2026-09-14', links: [{ url: pdfUrl('BILLS-119hr10167eh'), mediaType: 'application/pdf' }] })
    expect(byNote['Referred in Senate']).toMatchObject({ date: '2026-09-15', links: [{ url: pdfUrl('BILLS-119hr10167rfs'), mediaType: 'application/pdf' }] })
  })

  it('gives a version with no date its action\'s date: an enrolled bill\'s, the day the second chamber passed it', async () => {
    expect(obj('hr10167').bill.textVersions.item.find((v: any) => v.type === 'Enrolled Bill').date).toBe('')
    await ingest('HB10167')
    const enrolled = (await bill('HB10167')).texts.find((t: any) => t.note === 'Enrolled')
    expect(enrolled).toMatchObject({ date: '2026-09-28', links: [{ url: pdfUrl('BILLS-119hr10167enr'), mediaType: 'application/pdf' }] })
  })

  it.each([
    ['hr3132', 'HB3132', 'Introduced in House', 'Introduced', '2025-05-01', 'the day the bill was introduced'],
    ['hr10167', 'HB10167', 'Engrossed in House', 'Engrossed', '2026-09-14', 'the day the House passed it'],
    ['s2503', 'SB2503', 'Engrossed in Senate', 'Engrossed', '2025-12-17', 'the day the Senate passed it'],
    ['hres492', 'HR492', 'Engrossed in House', 'Engrossed', '2025-06-11', 'the day the House agreed to it'],
  ])('gives a %s version with no date, "%s", its action\'s date: %s', async (name, number, type, note, date) => {
    edit(name, x => x.replace(new RegExp(`(<type>${type}</type>\\s*)<date>[^<]*</date>`), '$1<date/>'))
    await ingest(number)
    expect((await bill(number)).texts.find((t: any) => t.note === note)).toMatchObject({ date })
  })

  it('takes a concurrent resolution\'s enrolled version\'s date from its second passage too', async () => {
    await ingest('HCR74')
    const { texts } = await bill('HCR74')
    expect(texts.find((t: any) => t.note === 'Enrolled')).toMatchObject({ date: '2026-02-12' })
    expect(texts.find((t: any) => t.note === 'Engrossed')).toMatchObject({ date: '2026-02-10' })
  })

  it('maps the version types to Introduced, Engrossed, Enrolled, and Chaptered, and keeps the name of any other', async () => {
    await ingest('HB43', 'HB837', 'SB2503', 'HR492', 'HB7895', 'SB4126', 'HB9238')
    const note = async (n: string) => (await bill(n)).texts.map((t: any) => t.note).sort()
    expect(await note('HB43')).toEqual(['Chaptered', 'Engrossed', 'Enrolled', 'Introduced', 'Received in Senate'])
    expect(await note('HB837')).toEqual(['Engrossed', 'Enrolled', 'Introduced', 'Referred in Senate', 'Reported to Senate'])
    expect(await note('SB2503')).toEqual(['Engrossed', 'Introduced', 'Reported to Senate'])
    expect(await note('HR492')).toEqual(['Engrossed', 'Introduced'])
    expect(await note('HB7895')).toEqual(['Introduced', 'Reported in House'])
    expect(await note('SB4126')).toEqual(['Placed on Calendar Senate'])
    expect(await note('HB9238')).toEqual(['Committee Discharged House'])
  })

  it('links a public law to its own package, and dates it', async () => {
    await ingest('HB43')
    const law = (await bill('HB43')).texts.find((t: any) => t.note === 'Chaptered')
    expect(law).toMatchObject({ date: '2025-07-08', links: [{ url: pdfUrl('PLAW-119publ23'), mediaType: 'application/pdf' }] })
  })

  it('mints each doc_id from the package id and hashes "govinfo:" plus the package id', async () => {
    await ingest('HB10167')
    const rows = await db().select().from(schema.billTexts).all()
    expect(rows).toHaveLength(4)
    const minted = new Map((await db().select().from(schema.providerIds).where(eq(schema.providerIds.kind, 'doc')).all()).map(r => [r.nativeKey, r.id]))
    expect([...minted.keys()].sort()).toEqual(['BILLS-119hr10167eh', 'BILLS-119hr10167enr', 'BILLS-119hr10167ih', 'BILLS-119hr10167rfs'])
    for (const [pkg, id] of minted) {
      const row = rows.find(r => r.docId === id)!
      expect(row.textHash).toBe(await sha256(`govinfo:${pkg}`))
      expect(row).toMatchObject({ stateLink: pdfUrl(pkg), mime: 'application/pdf', billId: await billId('HB10167') })
    }
    // Instances run AI for a bill whose texts arrive with a hash.
    expect((await bill('HB10167')).textHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes no text hash or doc_id when the same file is ingested again', async () => {
    await ingest('HB10167')
    const first = (await db().select().from(schema.billTexts).orderBy(asc(schema.billTexts.docId)).all()).map(r => [r.docId, r.textHash, r.date])
    await ingest('HB10167')
    await seam.ingest(await billId('HB10167'))
    const second = (await db().select().from(schema.billTexts).orderBy(asc(schema.billTexts.docId)).all()).map(r => [r.docId, r.textHash, r.date])
    expect(second).toEqual(first)
    expect(second).toHaveLength(4)
  })

  it('stores each PDF with the bill\'s texts, and keeps the bill when a PDF isn\'t there', async () => {
    missingPdfs.add('BILLS-119hr10167eh')
    await ingest('HB10167')
    const rows = await db().select().from(schema.billTexts).all()
    expect(rows).toHaveLength(4)
    expect(rows.filter(r => r.r2Key).length).toBe(3)
    expect(rows.find(r => !r.r2Key)!.fetchError).toMatch(/404/)
    // The text's link is still served: it isn't ours to withhold.
    expect((await bill('HB10167')).texts).toHaveLength(4)
  })

  it('leaves a version GovInfo has published no file for out, until it has one', async () => {
    // HR 766's public law version has no formats yet.
    const versions = arr(obj('hr766').bill.textVersions.item)
    expect(versions).toHaveLength(2)
    expect(versions.find((v: any) => v.type === 'Public Law').formats).toBe('')
    await ingest('HB766')
    expect((await bill('HB766')).texts.map((t: any) => t.note)).toEqual(['Introduced'])
  })

  it('serves a bill none of whose versions has a file no texts', async () => {
    await ingest('HB5185')
    const b = await bill('HB5185')
    expect(b.texts).toEqual([])
    expect(b.textStatus).toBe('no_texts')
  })

  it('serves a bill with no text versions no texts', async () => {
    await ingest('HB2')
    const b = await bill('HB2')
    expect(b.texts).toEqual([])
    expect(b.textStatus).toBe('no_texts')
  })

  it('dates a version from its own date, to the day, whatever the time of day', async () => {
    await ingest('HB3132')
    expect((await bill('HB3132')).texts).toEqual([expect.objectContaining({ date: '2025-05-01', note: 'Introduced' })])
  })
})

describe('committees and referrals', () => {
  it('serves a bill\'s committee and referral with ids minted from the system code', async () => {
    await ingest('HB3132')
    const b = await bill('HB3132')
    expect(b.committee).not.toBeNull()
    expect(b.committee).toEqual({ committeeId: expect.stringMatching(/^\d+$/), name: 'Veterans\' Affairs Committee', chamber: 'H' })
    expect(b.referrals).toEqual([{ date: '2025-05-01', committeeId: b.committee.committeeId, name: 'Veterans\' Affairs Committee', chamber: 'H' }])
    const minted = await db().select().from(schema.providerIds).where(eq(schema.providerIds.kind, 'committee')).all()
    expect(minted.map(m => [m.nativeKey, String(m.id)])).toEqual([['hsvr00', b.committee.committeeId]])
    expect(Number(b.committee.committeeId)).toBeGreaterThan(3_000_000_000)
  })

  it('makes the same committee in two bills one committee', async () => {
    // Natural Resources, hsii00, is in three of the recorded bills, and Energy and Natural Resources, sseg00, in three.
    await ingest('HB43', 'HB131', 'HB837', 'SB296')
    const natural = await Promise.all(['HB43', 'HB131', 'HB837'].map(async n => (await bill(n)).referrals.find((r: any) => r.name === 'Natural Resources Committee')))
    expect(natural.every(r => r !== undefined)).toBe(true)
    expect(new Set(natural.map(r => r.committeeId)).size).toBe(1)
    const rows = await db().select().from(schema.committees).all()
    expect(rows.filter(r => r.name === 'Natural Resources Committee')).toHaveLength(1)
    expect(rows.filter(r => r.name === 'Energy and Natural Resources Committee')).toHaveLength(1)
    expect(rows.every(r => r.provider === 'govinfo' && r.state === 'US')).toBe(true)
    expect(rows.find(r => r.name === 'Energy and Natural Resources Committee')).toMatchObject({ chamber: 'S', chamberId: 2 })
    expect(rows.find(r => r.name === 'Natural Resources Committee')).toMatchObject({ chamber: 'H', chamberId: 1 })
  })

  it('lists referrals oldest first, a House committee\'s before the Senate\'s after the bill passed', async () => {
    await ingest('HB10167')
    const { referrals } = await bill('HB10167')
    expect(referrals.map((r: any) => [r.date, r.name, r.chamber])).toEqual([
      ['2026-08-27', 'Financial Services Committee', 'H'],
      ['2026-09-15', 'Banking, Housing, and Urban Affairs Committee', 'S'],
    ])
  })

  it('makes each time a committee is referred a bill a referral of its own', async () => {
    edit('hr3132', x => x.replace('<item>\n            <name>Referred To</name>', '<item>\n            <name>Referred To</name>\n            <date>2025-05-02T10:00:00Z</date>\n          </item>\n          <item>\n            <name>Referred To</name>'))
    await ingest('HB3132')
    expect((await bill('HB3132')).referrals.map((r: any) => r.date)).toEqual(['2025-05-01', '2025-05-02'])
  })

  describe('the committee a bill is pending in: its latest referral not yet reported', () => {
    it.each([
      ['HB3132', 'hsvr00', 'a bill marked up but not reported'],
      ['HB5185', 'ssju00', 'a House-passed bill referred in the Senate'],
      ['HB6222', 'hspw00', 'a bill referred to two committees on one day, the first listed'],
      ['HB9238', 'hlig00', 'a bill referred to two committees on one day'],
      ['SB296', 'sseg00', 'a Senate bill referred'],
    ])('is %s\'s %s: %s', async (number, code, _why) => {
      await ingest(number)
      const b = await bill(number)
      const minted = await db().select().from(schema.providerIds).where(eq(schema.providerIds.nativeKey, code)).all()
      expect(minted, `an id for ${code}`).toHaveLength(1)
      const id = minted[0].id
      expect(b.committee?.committeeId, number).toBe(String(id))
      expect((await db().select().from(schema.bills).where(eq(schema.bills.billId, await billId(number))).get())!.pendingCommitteeId).toBe(id)
    })

    it.each([
      ['HB7895', 'reported by its committee'],
      ['SB2503', 'reported, and passed the Senate'],
      ['SJR133', 'discharged from its committee'],
      ['HB10167', 'passed both chambers, the Senate committee discharged'],
      ['HB837', 'presented to the President'],
      ['HB131', 'vetoed'],
      ['HB43', 'now law'],
    ])('is none for %s: %s', async (number) => {
      await ingest(number)
      expect((await bill(number)).committee).toBeNull()
      expect((await db().select().from(schema.bills).where(eq(schema.bills.billId, await billId(number))).get())!.pendingCommitteeId).toBeNull()
    })

    it('is none for a bill with no committees at all, and a bill with none still lists its other referrals', async () => {
      await ingest('HB2', 'SB4126')
      for (const n of ['HB2', 'SB4126']) {
        const b = await bill(n)
        expect(b.committee).toBeNull()
        expect(b.referrals).toEqual([])
      }
    })

    it('moves to the later referral when a committee is referred it again after reporting', async () => {
      edit('hr7895', x => x.replace('<item>\n            <name>Reported By</name>', '<item>\n            <name>Referred To</name>\n            <date>2026-07-10T10:00:00Z</date>\n          </item>\n          <item>\n            <name>Reported By</name>'))
      await ingest('HB7895')
      expect((await bill('HB7895')).committee).toMatchObject({ name: 'Education and Workforce Committee', chamber: 'H' })
    })
  })

  it('lists no subcommittee as a committee', async () => {
    edit('hr3132', x => x.replace('</activities>\n      </item>\n    </committees>', '</activities>\n        <subcommittees><item><systemCode>hsvr03</systemCode><name>Subcommittee on Technology Modernization</name><activities><item><name>Referred to</name><date>2025-05-02T10:00:00Z</date></item></activities></item></subcommittees>\n      </item>\n    </committees>'))
    await ingest('HB3132')
    const b = await bill('HB3132')
    expect(b.referrals.map((r: any) => r.name)).toEqual(['Veterans\' Affairs Committee'])
    expect((await db().select().from(schema.committees).all()).map(c => c.name)).toEqual(['Veterans\' Affairs Committee'])
  })
})

describe('subjects', () => {
  it('serves the legislative subjects in the feed\'s order, and not the policy area', async () => {
    await ingest('HB3132')
    const { subjects } = await bill('HB3132')
    const feed = arr(obj('hr3132').bill.subjects.legislativeSubjects.item).map((s: any) => s.name)
    expect(feed).toHaveLength(13)
    expect(subjects).toEqual(feed)
    expect(subjects).not.toContain('Armed Forces and National Security')
  })

  it('serves a bill with no legislative subjects none', async () => {
    await ingest('HB2', 'SCR5')
    expect((await bill('HB2')).subjects).toEqual([])
    expect((await bill('SCR5')).subjects).toEqual([])
  })
})

describe('related bills', () => {
  it('serves two bills that name each other "Identical bill" as identical, each other\'s', async () => {
    await ingest('HB131', 'SB296', 'SB2503', 'HB6222')
    const [hb131, sb296] = [await bill('HB131'), await bill('SB296')]
    expect(hb131.relatedBills).toContainEqual({
      identifier: 'SB296', sastBillId: await billId('SB296'), session: hb131.sessionId, relationType: 'identical-bill', kind: 'identical',
    })
    expect(sb296.relatedBills).toEqual([{
      identifier: 'HB131', sastBillId: await billId('HB131'), session: sb296.sessionId, relationType: 'identical-bill', kind: 'identical',
    }])
    const [sb2503, hb6222] = [await bill('SB2503'), await bill('HB6222')]
    expect(sb2503.relatedBills).toEqual([expect.objectContaining({ identifier: 'HB6222', kind: 'identical', sastBillId: await billId('HB6222') })])
    expect(hb6222.relatedBills).toEqual([expect.objectContaining({ identifier: 'SB2503', kind: 'identical', sastBillId: await billId('SB2503') })])
  })

  it('serves a "Related bill" as related', async () => {
    await ingest('HB131')
    expect((await bill('HB131')).relatedBills).toContainEqual(expect.objectContaining({ identifier: 'HB8646', relationType: 'related-bill', kind: 'related' }))
  })

  it('serves "Procedurally related" as related, under its own label', async () => {
    await ingest('HR492')
    expect((await bill('HR492')).relatedBills).toEqual([
      expect.objectContaining({ identifier: 'HB1', relationType: 'related-bill', kind: 'related' }),
      expect.objectContaining({ identifier: 'HR499', relationType: 'procedurally-related', kind: 'related' }),
    ])
  })

  it('numbers each related bill as LegiScan does, from its type', async () => {
    await ingest('HB9238')
    expect((await bill('HB9238')).relatedBills.map((r: any) => r.identifier)).toEqual(['HB9115', 'SB4764', 'SB4760'])
  })

  it('serves a bill related to two others in the same Congress once each, with its sast ids the ids the sync minted', async () => {
    await ingest('HB10167', 'SB296')
    const { relatedBills } = await bill('HB10167')
    expect(relatedBills.map((r: any) => r.identifier)).toEqual(['SB1525', 'HB4459', 'HB3074'])
    const ids = new Map((await db().select().from(schema.providerIds).where(eq(schema.providerIds.kind, 'bill')).all()).map(r => [r.nativeKey, r.id]))
    expect(relatedBills.map((r: any) => r.sastBillId)).toEqual(['119/S1525', '119/HR4459', '119/HR3074'].map(k => ids.get(k)))
  })

  it('labels a bill both identical and related as identical, one entry for it', async () => {
    // S 1525 is named an "Identical bill" and a "Related bill" at once.
    const detail = arr(obj('hr10167').bill.relatedBills.item).find((r: any) => r.number === '1525').relationshipDetails.item
    expect(arr(detail).map((d: any) => d.type).sort()).toEqual(['Identical bill', 'Related bill'])
    await ingest('HB10167')
    const entries = (await bill('HB10167')).relatedBills.filter((r: any) => r.identifier === 'SB1525')
    expect(entries).toEqual([expect.objectContaining({ kind: 'identical', relationType: 'identical-bill' })])
  })

  it('labels a bill two ways with the more specific label, over "Related bill"', async () => {
    edit('hr9238', x => x.replace(/(<number>9115<\/number>[\s\S]*?<relationshipDetails>)/, '$1<item><identifiedBy>House</identifiedBy><type>Procedurally related</type></item>'))
    await ingest('HB9238')
    expect((await bill('HB9238')).relatedBills[0]).toMatchObject({ identifier: 'HB9115', relationType: 'procedurally-related', kind: 'related' })
  })

  it('names a bill of another Congress with its Congress, so it isn\'t taken for this one\'s', async () => {
    await ingest('HB837')
    const { relatedBills } = await bill('HB837')
    expect(relatedBills).toEqual([
      expect.objectContaining({ identifier: 'HB1829 (118th Congress)', relationType: 'cross-congress-related-bill', kind: 'related' }),
      expect.objectContaining({ identifier: 'SB700', relationType: 'related-bill', kind: 'related' }),
    ])
    const ids = new Map((await db().select().from(schema.providerIds).where(eq(schema.providerIds.kind, 'bill')).all()).map(r => [r.nativeKey, r.id]))
    expect(relatedBills[0].sastBillId).toBe(ids.get('118/HR1829'))
    expect(ids.get('118/HR1829')).not.toBe(ids.get('119/HR1829'))
  })

  it('serves a bill with no related bills none', async () => {
    await ingest('HB3132')
    expect((await bill('HB3132')).relatedBills).toEqual([])
  })

  it('leaves a bill\'s relationship to itself out', async () => {
    edit('hr131', x => x.replace('<relatedBills>', '<relatedBills><item><congress>119</congress><latestAction><actionDate>2025-01-03</actionDate><text>x</text></latestAction><number>131</number><title>self</title><type>HR</type><relationshipDetails><item><identifiedBy>CRS</identifiedBy><type>Related bill</type></item></relationshipDetails></item>'))
    await ingest('HB131')
    const identifiers = (await bill('HB131')).relatedBills.map((r: any) => r.identifier)
    expect(identifiers).toEqual(['HB8646', 'SB296'])
  })
})

describe('extras', () => {
  const fields = async (n: string) => (await bill(n)).extras?.fields.map((f: any) => [f.key, f.value]) ?? []

  it('shows the latest summary only, with its version, and no HTML', async () => {
    expect(arr(obj('hr43').bill.summaries.summary).map((s: any) => s.actionDesc)).toEqual(['Introduced in House', 'Public Law'])
    await ingest('HB43')
    const extras = (await bill('HB43')).extras
    expect(extras).not.toBeNull()
    const summary = extras.fields.find((f: any) => f.key === 'summary')
    expect(summary).toMatchObject({ label: 'Summary', display: 'text' })
    expect(summary.value).toMatch(/^Public Law version \(July 7, 2025\)\n\n/)
    expect(summary.value).not.toMatch(/<[a-z/][^>]*>/i)
    expect(summary.value).not.toMatch(/&[a-z]+;|&#\d+;/)
    expect(summary.value).toContain(obj('hr43').bill.summaries.summary[1].text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 25))
    // The earlier summary isn't shown.
    expect(summary.value).not.toContain('Introduced in House')
    expect(summary.value).toContain('This act removes')
    expect(summary.value).not.toContain('This bill removes')
    expect(extras.fields.filter((f: any) => f.key === 'summary')).toHaveLength(1)
  })

  it('shows the public law number, the policy area, and no cost estimate for an enacted bill, in the vocabulary\'s order', async () => {
    await ingest('HB43')
    const extras = (await bill('HB43')).extras
    expect(extras).not.toBeNull()
    expect(extras.providerName).toBe('GovInfo Bill Status')
    expect(extras.fields.map((f: any) => [f.key, f.label, f.display])).toEqual([
      ['summary', 'Summary', 'text'],
      ['publicLaw', 'Public law', 'identifier'],
      ['policyArea', 'Policy area', 'text'],
    ])
    expect(extras.fields.find((f: any) => f.key === 'publicLaw').value).toBe('119-23')
    expect(extras.fields.find((f: any) => f.key === 'policyArea').value).toBe(obj('hr43').bill.policyArea.name)
  })

  it('shows the cost estimate link and the policy area, and no summary, for a bill with none', async () => {
    await ingest('HB3132')
    expect(await fields('HB3132')).toEqual([
      ['policyArea', 'Armed Forces and National Security'],
      ['costEstimate', 'https://www.cbo.gov/publication/61479'],
    ])
  })

  it('shows the newest of several cost estimates', async () => {
    edit('hr3132', x => x.replace('</cboCostEstimates>', '<item><pubDate>2025-07-20T21:30:00Z</pubDate><title>H.R. 3132, reported</title><url>https://www.cbo.gov/publication/99999</url><description>As reported</description></item><item><pubDate>2025-06-01T21:30:00Z</pubDate><title>earlier</title><url>https://www.cbo.gov/publication/11111</url><description>x</description></item></cboCostEstimates>'))
    await ingest('HB3132')
    expect((await fields('HB3132')).find(f => f[0] === 'costEstimate')?.[1]).toBe('https://www.cbo.gov/publication/99999')
  })

  it('shows the latest summary of a bill whose summaries are not oldest first', async () => {
    edit('hr43', x => {
      const summaries = [...x.matchAll(/\n      <summary>[\s\S]*?<\/summary>/g)].map(m => m[0])
      const open = x.indexOf('<summaries>') + '<summaries>'.length
      const close = x.indexOf('</summaries>')
      return x.slice(0, open) + summaries.reverse().join('') + '\n    ' + x.slice(close)
    })
    await ingest('HB43')
    expect((await fields('HB43')).find(f => f[0] === 'summary')?.[1]).toMatch(/^Public Law version/)
  })

  it('reads a summary the feed wraps in its own cdata element', async () => {
    edit('hr43', x => x.replace(/<text><!\[CDATA\[([\s\S]*?)\]\]><\/text>/g, '<cdata><text><![CDATA[$1]]></text></cdata>'))
    await ingest('HB43')
    const value = (await fields('HB43')).find(f => f[0] === 'summary')?.[1]
    expect(value).toMatch(/^Public Law version/)
    expect(value).not.toMatch(/<[a-z/][^>]*>/i)
  })

  it('has no extras for a bill with none of them', async () => {
    edit('hr7895', x => x.replace(/<policyArea>[\s\S]*?<\/policyArea>/, ''))
    await ingest('HB7895')
    expect((await bill('HB7895')).extras).toBeNull()
    expect(await db().select().from(schema.billExtras).where(eq(schema.billExtras.billId, await billId('HB7895'))).all()).toEqual([])
  })

  it('shows a private law\'s number nowhere: the extra is the public law number', async () => {
    edit('hr43', x => x.replace('<type>Public Law</type>\n        <number>119-23</number>', '<type>Private Law</type>\n        <number>119-1</number>'))
    await ingest('HB43')
    expect((await fields('HB43')).map(f => f[0])).toEqual(['summary', 'policyArea'])
  })

  it('clears an extra the bill no longer has, on the next ingest', async () => {
    await ingest('HB3132')
    expect((await fields('HB3132')).map(f => f[0])).toContain('costEstimate')
    edit('hr3132', x => x.replace(/<cboCostEstimates>[\s\S]*?<\/cboCostEstimates>/, ''))
    await ingest('HB3132')
    expect((await fields('HB3132')).map(f => f[0])).toEqual(['policyArea'])
  })
})

describe('the hash rule', () => {
  it('leaves a bill\'s detail and its record hash alone when only the file\'s updateDate moves', async () => {
    await ingest('HB3132')
    const before = await bill('HB3132')
    expect(before.sponsors).toHaveLength(61)
    const hash = (await db().select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, await billId('HB3132'))).get())!.rawHash
    edit('hr3132', x => x.replace(/(<updateDate>)[^<]*(<\/updateDate>)/g, '$12026-10-18T05:00:00Z$2'))
    const run = makeRun()
    await sync(run)
    expect(queuedIds(run)).toEqual([])
    expect((await db().select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, await billId('HB3132'))).get())!.rawHash).toBe(hash)
    expect(await bill('HB3132')).toEqual(before)
  })

  it('queues a bill whose file changes, and the next ingest serves the change', async () => {
    await ingest('HB3132')
    expect((await bill('HB3132')).sponsors).toHaveLength(61)
    edit('hr3132', x => x.replace(/(<cosponsors>)/, '$1<item><bioguideId>Z999999</bioguideId><fullName>Rep. New, Member [D-CA-1]</fullName><firstName>Member</firstName><lastName>New</lastName><party>D</party><state>CA</state><district>1</district><sponsorshipDate>2025-06-01</sponsorshipDate><isOriginalCosponsor>False</isOriginalCosponsor></item>'))
    const { run } = await syncAndIngest()
    expect(queuedIds(run)).toEqual([await billId('HB3132')])
    const { sponsors } = await bill('HB3132')
    expect(sponsors).toHaveLength(62)
    expect(sponsors[1].name).toBe('Member New')
  })
})

describe('failing closed', () => {
  const broken = (number: string, name: string, change: (x: string) => string) => {
    edit(name, change)
    return number
  }

  it.each([
    ['HTTP 404', () => new Response('not found', { status: 404 })],
    ['HTTP 500', () => new Response('error', { status: 500 })],
    ['HTTP 429', () => new Response('slow down', { status: 429 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['a web page', () => new Response('<html><body>Service unavailable</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['text that isn\'t XML', () => new Response('this is not a bill', { status: 200 })],
    ['bytes that aren\'t UTF-8', () => new Response(new Uint8Array([0x3c, 0x62, 0xff, 0xfe, 0x3e]), { status: 200 })],
    ['a bill cut off in the middle', () => new Response(fixtureFiles.get('BILLSTATUS-119hr3132.xml')!.slice(0, 1500), { status: 200 })],
    ['a redirect with no body', () => new Response(null, { status: 302, headers: { location: 'https://example.com/' } })],
  ])('writes nothing and retries when the file is %s', async (_what, answer) => {
    fileAnswers.set(file('hr3132'), answer)
    await ingestFailing('HB3132')
    await nothingWritten()
  })

  it.each([
    ['a Bill Status file for another bill', 'hr3132', () => xml('hr7895')],
    ['a file of another type', 'hr3132', () => xml('hr3132').replace('<type>HR</type>', '<type>S</type>')],
    ['a file of another Congress', 'hr3132', () => xml('hr3132').replace('<congress>119</congress>', '<congress>118</congress>')],
    ['a file that isn\'t Bill Status', 'hr3132', () => '<?xml version="1.0"?><html><body>hi</body></html>'],
    ['a file with no bill', 'hr3132', () => '<billStatus><version>3.0.0</version></billStatus>'],
  ])('writes nothing and retries when GovInfo answers with %s', async (_what, name, content) => {
    fileAnswers.set(file(name), () => new Response(content(), { status: 200 }))
    await ingestFailing('HB3132')
    await nothingWritten()
  })

  it.each([
    ['a sponsor with no Bioguide id', 'hr3132', (x: string) => x.replace('<bioguideId>B001301</bioguideId>', '')],
    ['a sponsor with a malformed Bioguide id', 'hr3132', (x: string) => x.replace('<bioguideId>B001301</bioguideId>', '<bioguideId>not-an-id</bioguideId>')],
    ['a sponsor with no last name', 'hr3132', (x: string) => x.replace('<lastName>Bergman</lastName>', '')],
    ['a sponsor of no known title', 'hr3132', (x: string) => x.replace('<fullName>Rep. Bergman', '<fullName>Gov. Bergman')],
    ['a bill with no sponsor at all', 'hr3132', (x: string) => x.replace(/<sponsors>[\s\S]*?<\/sponsors>/, '')],
    ['a cosponsor with no Bioguide id', 'hr3132', (x: string) => x.replace(/(<cosponsors>\s*<item>\s*)<bioguideId>[^<]*<\/bioguideId>/, '$1')],
    ['an action with no date', 'hr3132', (x: string) => x.replace(/(<actions>\s*<item>\s*)<actionDate>[^<]*<\/actionDate>/, '$1')],
    ['an action with a date that isn\'t one', 'hr3132', (x: string) => x.replace(/(<actions>\s*<item>\s*<actionDate>)[^<]*/, '$1last Tuesday')],
    ['an action with no text', 'hr3132', (x: string) => x.replace(/(<actions>\s*<item>[\s\S]*?)<text>[^<]*<\/text>/, '$1')],
    ['a committee with no system code', 'hr3132', (x: string) => x.replace('<systemCode>hsvr00</systemCode>', '')],
    ['a committee with a system code that isn\'t one', 'hr3132', (x: string) => x.replace('hsvr00', 'Veterans')],
    ['a committee with no name', 'hr3132', (x: string) => x.replace('<name>Veterans\' Affairs Committee</name>', '')],
    ['a committee of no known chamber', 'hr3132', (x: string) => x.replace('<chamber>House</chamber>', '<chamber>Joint</chamber>')],
    ['a text version with a link that isn\'t GovInfo\'s', 'hr3132', (x: string) => x.replace('https://www.govinfo.gov/content/pkg/BILLS-119hr3132ih', 'https://example.com/content/pkg/BILLS-119hr3132ih')],
    ['a text version with a link that names no package', 'hr3132', (x: string) => x.replace('/content/pkg/BILLS-119hr3132ih/xml/BILLS-119hr3132ih.xml', '/content/pkg/')],
    ['a text version linking two packages', 'hr3132', (x: string) => x.replace('<url>https://www.govinfo.gov/content/pkg/BILLS-119hr3132ih/xml/BILLS-119hr3132ih.xml</url>', '<url>https://www.govinfo.gov/content/pkg/BILLS-119hr3132ih/xml/BILLS-119hr3132ih.xml</url></item><item><url>https://www.govinfo.gov/content/pkg/BILLS-119hr3132eh/xml/BILLS-119hr3132eh.xml</url>')],
    ['a reported version with no date, which names no action to take one from', 'hr7895', (x: string) => x.replace(/(<type>Reported in House<\/type>\s*)<date>[^<]*<\/date>/, '$1<date/>')],
    ['a text version with a date that isn\'t one', 'hr3132', (x: string) => x.replace('<date>2025-05-01T04:00:00Z</date>', '<date>May first</date>')],
    ['a text version with no type', 'hr3132', (x: string) => x.replace('<type>Introduced in House</type>', '')],
    ['an enrolled version with no date and no passage to take one from', 'hr10167', (x: string) => x.replace(/<actionCode>(8000|17000)<\/actionCode>/g, '<actionCode>8001</actionCode>')],
    ['a related bill of no known type', 'hr131', (x: string) => x.replace('<number>296</number>\n        <type>S</type>', '<number>296</number>\n        <type>XYZ</type>')],
    ['a related bill with no number', 'hr131', (x: string) => x.replace(/<number>296<\/number>/, '')],
    ['a related bill with no relationship', 'hr131', (x: string) => x.replace(/<relationshipDetails>[\s\S]*?<\/relationshipDetails>/, '<relationshipDetails/>')],
    ['a legislative subject with no name', 'hr3132', (x: string) => x.replace('<name>Administrative law and regulatory procedures</name>', '')],
  ])('writes nothing and retries on %s', async (_what, name, change) => {
    const number = { hr3132: 'HB3132', hr10167: 'HB10167', hr131: 'HB131', hr7895: 'HB7895' }[name]!
    await ingestFailing(broken(number, name, change))
    await nothingWritten()
  })

  it('keeps what an earlier ingest stored when a later one fails, and says nothing to instances', async () => {
    await ingest('HB3132')
    const before = await bill('HB3132')
    const stored = await detailRows()
    edit('hr3132', x => x.replace('<bioguideId>B001301</bioguideId>', ''))
    const messages = await seam.ingest(await billId('HB3132'))
    expect(messages[0].retry).toHaveBeenCalled()
    expect(await bill('HB3132')).toEqual(before)
    expect(await detailRows()).toEqual(stored)
  })

  it('mints no id for a file it could not read', async () => {
    edit('hr3132', x => x.replace('<bioguideId>B001301</bioguideId>', ''))
    await ingestFailing('HB3132')
    const minted = await db().select().from(schema.providerIds).all()
    expect(minted.filter(m => ['person', 'doc', 'committee', 'subject'].includes(m.kind))).toEqual([])
  })

  it('reads the next bill after one fails: a bad file holds back that bill alone', async () => {
    edit('hr7895', x => x.replace(/<sponsors>[\s\S]*?<\/sponsors>/, ''))
    await sync()
    const messages = await seam.ingest([await billId('HB3132'), await billId('HB7895'), await billId('SB296')])
    expect(messages.map(m => m.retry.mock.calls.length)).toEqual([0, 1, 0])
    expect((await bill('HB3132')).sponsors).toHaveLength(61)
    expect((await bill('SB296')).sponsors).toHaveLength(2)
    expect((await bill('HB7895')).sponsors).toEqual([])
  })
})

describe('every recorded bill', () => {
  it('ingests, with its sponsor, its history, and a text for each version GovInfo has a file for', async () => {
    await sync()
    const numbers = [...fixtureFiles.keys()].map(n => /^BILLSTATUS-119([a-z]+)(\d+)\.xml$/.exec(n)!)
    const prefix: Record<string, string> = { hr: 'HB', s: 'SB', hres: 'HR', sres: 'SR', hjres: 'HJR', sjres: 'SJR', hconres: 'HCR', sconres: 'SCR' }
    const all = numbers.map(m => `${prefix[m[1]]}${m[2]}`)
    const messages = await seam.ingest(await Promise.all(all.map(billId)))
    for (const m of messages) expect(m.retry, JSON.stringify(m.body)).not.toHaveBeenCalled()
    for (const [i, m] of numbers.entries()) {
      const feed = obj(`${m[1]}${m[2]}`).bill
      const b = await bill(all[i])
      expect(b.sponsors[0].primary, all[i]).toBe(true)
      const withdrawn = arr(feed.cosponsors?.item).filter((c: any) => c.sponsorshipWithdrawnDate).length
      expect(b.sponsors, all[i]).toHaveLength(1 + arr(feed.cosponsors?.item).length - withdrawn)
      const withFile = arr(feed.textVersions?.item).filter((v: any) => arr(v.formats?.item).length > 0)
      expect(b.texts, all[i]).toHaveLength(withFile.length)
      expect(b.subjects, all[i]).toHaveLength(arr(feed.subjects?.legislativeSubjects?.item).length)
      const actions = arr(feed.actions?.item)
      // The Library of Congress lists an introduction under its older code, Intro-H or Intro-S, too, and a few bills are introduced twice over: one stays.
      const kept = actions.filter((a: any) => !/^Intro-[HS]$/.test(a.actionCode))
      const introduced = kept.filter((a: any) => /^Introduced in (House|Senate)$/.test(a.text)).length
      expect(b.actions, all[i]).toHaveLength(kept.length - Math.max(0, introduced - 1))
    }
  })
})
