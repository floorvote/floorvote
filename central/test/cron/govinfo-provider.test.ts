import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'

// Congress from GovInfo's Bill Status bulk data at the main seam (#615): small
// zips built from recorded real Bill Status files go in, with the network
// stubbed at fetch, and central's bill API, its labels, and the notifications
// queued for an instance come out. Every zip is served a few kilobytes at a
// time, with every way of reading a whole body at once made to throw, so a
// provider that buffers a zip whole fails every test here.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { govinfo } from '../../src/providers/govinfo'
import { toHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral, type Run } from '../helpers/mainSeam'
import { BILL_TYPES, buildZip, fileType, fixtureFiles, serveZip, zipLayout } from '../helpers/govinfoZip'

const ZIP_URL = /^https:\/\/www\.govinfo\.gov\/bulkdata\/BILLSTATUS\/(\d+)\/([a-z]+)\/BILLSTATUS-\d+-([a-z]+)\.zip$/
const zipUrl = (type: string, congress = 119) => `https://www.govinfo.gov/bulkdata/BILLSTATUS/${congress}/${type}/BILLSTATUS-${congress}-${type}.zip`

type Type = typeof BILL_TYPES[number]
type Served = () => Response

/** The Bill Status files the stubbed GovInfo serves, by file name. A test replaces entries to change a bill. */
let files: Map<string, string>
/** What the stubbed GovInfo answers for each type's zip. A test replaces one to break it. */
let answers: Map<Type, Served>
/** Every request: method, URL, and Accept header. */
let calls: { method: string; url: string; accept: string | null }[]
/** The Last-Modified header the zips carry. */
let lastModified = 'Sat, 17 Oct 2026 00:19:30 GMT'

const zipOf = (type: Type, from = files) => buildZip(
  [...from].filter(([name]) => fileType(name) === type).map(([name, data]) => ({ name, data })))
const serve = (type: Type, from = files): Served => () => serveZip(zipOf(type, from), { headers: { 'last-modified': lastModified } }).response
function serveAll() {
  answers = new Map(BILL_TYPES.map(t => [t, serve(t)]))
}

const seam = mainSeam(govinfo, { tenantId: 'usteam' })
const { makeRun, queuedIds, sentToTenant, getJson, sync, syncAndIngest } = seam
const claim = (provider = 'govinfo') => seam.claim('US', provider)
const billId = (number: string) => seam.billIdOf(number)
const bill = async (number: string) => getJson(`/bills/${toHandle(await billId(number))}`)
const db = () => drizzle(env.DB, { schema })

const file = (name: string) => `BILLSTATUS-119${name}.xml`
const xml = (name: string) => fixtureFiles.get(file(name))!

beforeEach(async () => {
  await resetCentral()
  files = new Map(fixtureFiles)
  calls = []
  lastModified = 'Sat, 17 Oct 2026 00:19:30 GMT'
  serveAll()
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, accept: new Headers(init?.headers).get('Accept') })
    const m = ZIP_URL.exec(url)
    if (m && m[2] === m[3] && m[1] === '119') return answers.get(m[2] as Type)!()
    return new Response('not found', { status: 404 })
  })
  // The instance follows Congress with one keyword, which only the CHOICE for Veterans Act matches.
  await seam.addTenant('US', ['choice for veterans'])
})

afterEach(() => {
  vi.useRealTimers()
})

/** [file, the number central serves, status label, bill type]. */
const BILLS: [string, string, string, string][] = [
  ['hr2', 'HB2', 'Introduced', 'B'],
  ['hr3132', 'HB3132', 'In committee', 'B'],
  ['hr7895', 'HB7895', 'Reported', 'B'],
  ['hr9238', 'HB9238', 'Failed', 'B'],
  ['hr131', 'HB131', 'Vetoed', 'B'],
  ['hr766', 'HB766', 'Became law', 'B'],
  ['hr837', 'HB837', 'Presented to the President', 'B'],
  ['hr10167', 'HB10167', 'Passed both chambers', 'B'],
  ['hr5185', 'HB5185', 'Passed House', 'B'],
  ['s5531', 'SB5531', 'In committee', 'B'],
  ['s4126', 'SB4126', 'Introduced', 'B'],
  ['s2503', 'SB2503', 'Passed Senate', 'B'],
  ['hres492', 'HR492', 'Agreed to', 'R'],
  ['sres611', 'SR611', 'Agreed to', 'R'],
  ['hjres219', 'HJR219', 'In committee', 'JR'],
  ['sjres133', 'SJR133', 'Reported', 'JR'],
  ['hconres74', 'HCR74', 'Agreed to', 'CR'],
  ['sconres5', 'SCR5', 'In committee', 'CR'],
]

/** Stage and rank of each status label, as #612's Status table has them. */
const STATUSES: Record<string, [stage: string, rank: number]> = {
  'Introduced': ['introduced', 101],
  'In committee': ['in_committee', 201],
  'Reported': ['in_committee', 202],
  'Passed House': ['passed_one_chamber', 301],
  'Passed Senate': ['passed_one_chamber', 302],
  'Passed both chambers': ['passed', 401],
  'Presented to the President': ['passed', 402],
  'Failed': ['failed', 501],
  'Vetoed': ['vetoed', 601],
  'Became law': ['enacted', 701],
  'Agreed to': ['enacted', 702],
}

describe('Congress from GovInfo Bill Status', () => {
  it('stays on LegiScan until Congress is claimed', async () => {
    const run = makeRun()
    expect(await sync(run)).toEqual([])
    expect(calls).toEqual([])
    expect(run.queue.sendBatch).not.toHaveBeenCalled()
  })

  it('serves every bill in the zips once US is claimed, under LegiScan\'s numbers, with no key and no LegiScan call', async () => {
    expect((await claim()).status).toBe(200)
    await syncAndIngest()
    // One download of each type's zip, and nothing else.
    expect(calls.map(c => [c.method, c.url])).toEqual(BILL_TYPES.map(t => ['GET', zipUrl(t)]))
    for (const [name, number, , billType] of BILLS) {
      const b = await bill(number)
      expect(b, name).toMatchObject({ number, state: 'US', billType })
    }
    // LegiScan numbers Congress's House bill HB, its House resolution HR, and so on.
    expect(BILLS.map(([, n]) => n.replace(/\d+$/, '')).filter((p, i, all) => all.indexOf(p) === i).sort())
      .toEqual(['HB', 'HCR', 'HJR', 'HR', 'SB', 'SCR', 'SJR', 'SR'])
  })

  it('maps all eight Congress bill types to LegiScan\'s prefixes', async () => {
    await claim()
    await syncAndIngest()
    // HR 3132 is HB3132, and HRES 492 is HR492.
    expect(await bill('HB3132')).toMatchObject({ number: 'HB3132', state: 'US' })
    expect(await bill('HR492')).toMatchObject({ number: 'HR492', billType: 'R' })
    const prefixes = new Map<string, string>()
    for (const [name, number] of BILLS) prefixes.set(name.replace(/\d+$/, ''), number.replace(/\d+$/, ''))
    expect(Object.fromEntries(prefixes)).toEqual({
      hr: 'HB', s: 'SB', hres: 'HR', sres: 'SR', hjres: 'HJR', sjres: 'SJR', hconres: 'HCR', sconres: 'SCR',
    })
  })

  it.each(BILLS)('derives %s\'s status from its structured fields: %s is %s', async (_name, number, status) => {
    await claim()
    await syncAndIngest()
    const [stage, rank] = STATUSES[status]
    expect(await bill(number)).toMatchObject({ status, statusStage: stage, statusRank: rank })
  })

  it('covers every status in the Status table, with an explainer for each', async () => {
    await claim()
    await syncAndIngest()
    const seen = new Set<string>()
    for (const [, number] of BILLS) seen.add((await bill(number)).status)
    expect([...seen].sort()).toEqual(Object.keys(STATUSES).sort())

    const labels = await getJson('/bills/labels?state=US')
    expect(labels.statuses.map((s: any) => s.label).sort()).toEqual(Object.keys(STATUSES).sort())
    for (const s of labels.statuses) expect(s.explainer.trim(), s.label).not.toBe('')
    expect(labels.billTypes.map((t: any) => t.value).sort()).toEqual(['B', 'CR', 'JR', 'R'])
  })

  it('sends a matching instance its matched bills as full notifications, and the rest as monitor stubs', async () => {
    await claim()
    const { run } = await syncAndIngest()
    const hb3132 = await billId('HB3132')
    expect(queuedIds(run)).toEqual([hb3132])
    const sent = sentToTenant(run)
    expect(sent.filter((m: any) => !m.stubOnly).map((m: any) => m.billId)).toEqual([toHandle(hb3132)])
    expect(sent.filter((m: any) => m.stubOnly)).toHaveLength(BILLS.length - 1)
  })

  it('serves a matched bill\'s title, official title as its description, status date, and latest action', async () => {
    await claim()
    await syncAndIngest()
    const b = await bill('HB3132')
    expect(b).toMatchObject({
      title: 'CHOICE for Veterans Act of 2025',
      abstract: expect.stringMatching(/^To amend title 38, United States Code, to allow for certain fee agreements/),
      status: 'In committee',
      statusDate: '2025-05-01',
      lastAction: 'Ordered to be Reported by the Yeas and Nays: 12 - 11.',
      lastActionDate: '2025-05-06',
      stateUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/3132',
    })
  })

  it('stores a compact record for each bill, with the zip\'s last-modified time and the chambers it has been in', async () => {
    await claim()
    await syncAndIngest()
    const rows = await db().select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, await billId('HB3132'))).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].nativeKey).toBe('119/HR3132')
    expect(JSON.parse(rows[0].rawJson)).toEqual({
      congress: 119, type: 'HR', number: '3132',
      title: 'CHOICE for Veterans Act of 2025',
      officialTitle: expect.stringMatching(/^To amend title 38, United States Code/),
      introducedDate: '2025-05-01',
      originChamber: 'H', currentChamber: 'H',
      status: 402, statusDate: '2025-05-01',
      latestAction: { date: '2025-05-06', text: 'Ordered to be Reported by the Yeas and Nays: 12 - 11.' },
      url: 'https://www.congress.gov/bill/119th-congress/house-bill/3132',
      modified: '2026-10-17T00:19:30Z',
    })
    // The whole file isn't kept: a stored record is well under a kilobyte or two.
    expect(rows[0].rawJson.length).toBeLessThan(1500)
    expect(rows[0].rawHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('moves a bill to the other chamber once its own has passed it', async () => {
    await claim()
    await syncAndIngest()
    const chambers = async (number: string) => {
      const row = await db().select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, await billId(number))).get()
      const { originChamber, currentChamber } = JSON.parse(row!.rawJson)
      return `${originChamber}>${currentChamber}`
    }
    expect(await chambers('HB5185')).toBe('H>S') // passed the House
    expect(await chambers('SB2503')).toBe('S>H') // passed the Senate
    expect(await chambers('HB3132')).toBe('H>H') // still in committee
    expect(await chambers('HR492')).toBe('H>H') // a simple resolution is done in its own chamber
  })
})

describe('the session', () => {
  it('is the 119th Congress, 2025 to 2026, tagged 119, and not adjourned', async () => {
    await claim()
    await syncAndIngest()
    const rows = await db().select().from(schema.sessions).where(eq(schema.sessions.provider, 'govinfo')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'US', sessionName: '119th Congress', yearStart: 2025, yearEnd: 2026, sessionTag: '119',
      sineDie: 0, prior: 0, special: 0,
    })
    expect((await getJson('/bills/sessions?state=US')).sessions).toEqual([
      expect.objectContaining({ sessionName: '119th Congress', yearStart: 2025, yearEnd: 2026 }),
    ])
    expect(await bill('HB3132')).toMatchObject({ sessionName: '119th Congress', yearStart: 2025, yearEnd: 2026 })
  })
})

describe('listing the current Congress', () => {
  const sessionsOn = async (today: string) => {
    const ctx = {
      today,
      ids: async (_kind: string, keys: readonly string[]) => new Map(keys.map((k, i) => [k, 1000 + i])),
    } as any
    return govinfo.listSessions('US', ctx)
  }

  // A Congress begins on January 3 of an odd year and runs two years.
  it.each([
    ['2025-01-03', '119th Congress', 2025, 2026, '119'],
    ['2026-12-31', '119th Congress', 2025, 2026, '119'],
    ['2027-01-02', '119th Congress', 2025, 2026, '119'],
    ['2027-01-03', '120th Congress', 2027, 2028, '120'],
    ['2028-09-01', '120th Congress', 2027, 2028, '120'],
    ['2029-01-03', '121st Congress', 2029, 2030, '121'],
    ['2031-03-01', '122nd Congress', 2031, 2032, '122'],
    ['2033-03-01', '123rd Congress', 2033, 2034, '123'],
  ])('on %s the current Congress is the %s (%i to %i)', async (today, name, from, to, tag) => {
    expect(await sessionsOn(today)).toEqual([expect.objectContaining({
      session_name: name, year_start: from, year_end: to, session_tag: tag, sine_die: 0, prior: 0, special: 0,
    })])
  })

  it('gives each Congress a session id of its own', async () => {
    const ids = new Map<string, number>()
    const ctx = (today: string) => ({
      today,
      ids: async (_kind: string, keys: readonly string[]) => new Map(keys.map(k => [k, ids.get(k) ?? (ids.set(k, 5000 + ids.size), ids.get(k)!)])),
    }) as any
    const [a] = await govinfo.listSessions('US', ctx('2026-09-01'))
    const [b] = await govinfo.listSessions('US', ctx('2027-02-01'))
    const [again] = await govinfo.listSessions('US', ctx('2026-10-01'))
    expect(a.session_id).not.toBe(b.session_id)
    expect(again.session_id).toBe(a.session_id)
  })
})

describe('a restamped file', () => {
  const restamp = (xmlText: string, to = '2026-10-17T05:00:00Z') =>
    xmlText.replace(/(<updateDate>)[^<]*(<\/updateDate>)/g, `$1${to}$2`)
      .replace(/(<updateDateIncludingText>)[^<]*(<\/updateDateIncludingText>)/g, `$1${to}$2`)

  const hashOf = async (number: string) =>
    (await db().select().from(schema.providerRecords).where(eq(schema.providerRecords.billId, await billId(number))).get())!.rawHash

  it('keeps its record hash and queues nothing when only its updateDate moved', async () => {
    await claim()
    await syncAndIngest()
    const before = await hashOf('HB3132')
    const stored = await bill('HB3132')

    for (const name of ['hr3132', 'hr7895', 's4126']) files.set(file(name), restamp(xml(name)))
    serveAll()
    const run = makeRun()
    await sync(run)
    expect(await hashOf('HB3132')).toBe(before)
    expect(queuedIds(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
    expect(await bill('HB3132')).toEqual(stored)
  })

  it('keeps its hash when the Dublin Core block changes, and when the zip is a new one', async () => {
    await claim()
    await syncAndIngest()
    const before = await hashOf('HB3132')
    files.set(file('hr3132'), xml('hr3132').replace('public domain.', 'the public domain, regenerated.'))
    lastModified = 'Sun, 18 Oct 2026 03:00:00 GMT'
    serveAll()
    const run = makeRun()
    await sync(run)
    expect(await hashOf('HB3132')).toBe(before)
    expect(queuedIds(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
  })

  it('changes its hash and queues a matched bill when anything else in the file changes', async () => {
    await claim()
    await syncAndIngest()
    const before = await hashOf('HB3132')
    files.set(file('hr3132'), xml('hr3132').replace('Ordered to be Reported by the Yeas and Nays: 12 - 11.', 'Reported by the Committee on Veterans\' Affairs. H. Rept. 119-1.'))
    serveAll()
    const run = makeRun()
    await sync(run)
    expect(await hashOf('HB3132')).not.toBe(before)
    expect(queuedIds(run)).toEqual([await billId('HB3132')])
  })

  it('tells a restamp from a real change in the same file', async () => {
    await claim()
    await syncAndIngest()
    const before = await hashOf('HB3132')
    // A restamp and a new title, together, is a change.
    files.set(file('hr3132'), restamp(xml('hr3132')).replace('<title>CHOICE for Veterans Act of 2025</title>', '<title>CHOICE for Veterans Act</title>'))
    serveAll()
    await sync()
    expect(await hashOf('HB3132')).not.toBe(before)
  })
})

describe('status derived from structured fields, oldest action first', () => {
  /** The file with its actions replaced by these items, newest first, as the feed lists them. */
  const withActions = (xmlText: string, items: string) => {
    const open = xmlText.indexOf('\n    <actions>')
    const close = xmlText.indexOf('\n    </actions>')
    return `${xmlText.slice(0, open)}\n    <actions>\n${items}${xmlText.slice(close)}`
  }
  /** The file with these action items put first, where the feed puts its newest. */
  const withNewest = (xmlText: string, items: string) => xmlText.replace('\n    <actions>', `\n    <actions>\n${items}`)
  /** The file without its action items that carry this action code. */
  const withoutCode = (xmlText: string, code: string) => {
    const starts = [...xmlText.matchAll(/<item>\s*<actionDate>/g)].map(m => m.index!)
    let out = xmlText
    for (const at of starts.reverse()) {
      let depth = 0
      let end = at
      for (const m of out.slice(at).matchAll(/<(\/?)item>/g)) {
        depth += m[1] ? -1 : 1
        if (depth === 0) { end = at + m.index! + '</item>'.length; break }
      }
      if (out.slice(at, end).includes(`<actionCode>${code}</actionCode>`)) out = out.slice(0, at) + out.slice(end)
    }
    return out
  }
  const action = (date: string, type: string, code: string | null, text: string, extra = '') => `      <item>
        <actionDate>${date}</actionDate>${extra}
        <text>${text}</text>
        <type>${type}</type>${code ? `\n        <actionCode>${code}</actionCode>` : ''}
        <sourceSystem><code>2</code><name>House floor actions</name></sourceSystem>
      </item>
`

  async function statusOf(name: string, number: string, mutate: (x: string) => string) {
    files.set(file(name), mutate(xml(name)))
    serveAll()
    await claim()
    await syncAndIngest()
    return (await bill(number)).status
  }

  it('lets a passage after a failed vote win: failed, then passed the House', async () => {
    expect(await statusOf('hr9238', 'HB9238', x => withNewest(x,
      action('2026-06-12', 'Floor', '8000', 'Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by the Yeas and Nays.')))).toBe('Passed House')
  })

  it('keeps Failed when nothing passes after the failed vote', async () => {
    expect(await statusOf('hr9238', 'HB9238', x => x)).toBe('Failed')
  })

  it('leaves a Senate-passed bill at Passed Senate when its suspension vote fails in the House', async () => {
    expect(await statusOf('s2503', 'SB2503', x => x)).toBe('Passed Senate')
  })

  it('reads the feed as newest first: the action listed first is the latest', async () => {
    const referral = action('2026-06-12', 'Committee', null, 'Referred to the Committee on Rules.',
      '\n        <committees><item><systemCode>hsru00</systemCode><name>Committee on Rules</name></item></committees>')
    const failure = action('2026-06-11', 'Floor', '9000', 'Failed of passage/not agreed to in House.')
    // Failed on the 11th, then referred on the 12th: the referral listed first is the later, so the bill is in committee.
    expect(await statusOf('hr9238', 'HB9238', x => withActions(x, referral + failure))).toBe('In committee')
    // The same two actions the other way round: referred, then failed.
    const failedLater = action('2026-06-12', 'Floor', '9000', 'Failed of passage/not agreed to in House.')
    const referredEarlier = action('2026-06-11', 'Committee', null, 'Referred to the Committee on Rules.',
      '\n        <committees><item><systemCode>hsru00</systemCode><name>Committee on Rules</name></item></committees>')
    expect(await statusOf('hr9238', 'HB9238', x => withActions(x, failedLater + referredEarlier))).toBe('Failed')
  })

  it('does not take a House duplicate of a veto, coded as a signature, for a law', async () => {
    // HR 131's veto is listed twice on one day: code 31000, and E30000, the code for a signature.
    expect(await statusOf('hr131', 'HB131', x => x)).toBe('Vetoed')
  })

  it('reads a signature coded E30000 on a day with no veto as a law', async () => {
    expect(await statusOf('hr837', 'HB837', x => withNewest(x,
      action('2026-01-02', 'President', 'E30000', 'Signed by President.')))).toBe('Became law')
  })

  it('reads a bill with a laws element as a law, whatever its action codes say', async () => {
    expect(await statusOf('hr7895', 'HB7895', x => x.replace('</latestAction>', '</latestAction>\n    <laws><item><number>119-99</number><type>Public Law</type></item></laws>'))).toBe('Became law')
  })

  it('reads a bill whose only referral is its committee activity as in committee', async () => {
    const committees = `<committees><item><systemCode>ssfi00</systemCode><name>Finance Committee</name><chamber>Senate</chamber><type>Standing</type>
      <activities><item><name>Referred To</name><date>2026-03-18T10:00:00Z</date></item></activities></item></committees>`
    expect(await statusOf('s4126', 'SB4126', x => x.replace('<actions>', `${committees}\n    <actions>`))).toBe('In committee')
  })

  it('leaves a Senate bill placed straight on the calendar at Introduced', async () => {
    expect(await statusOf('s4126', 'SB4126', x => x)).toBe('Introduced')
  })

  it('reads a bill with no actions at all as Introduced', async () => {
    expect(await statusOf('hr2', 'HB2', x => x)).toBe('Introduced')
    const b = await bill('HB2')
    expect(b).toMatchObject({ lastAction: null, lastActionDate: null })
  })

  it('keeps a reported bill at Reported when another committee is later named', async () => {
    expect(await statusOf('hr7895', 'HB7895', x => withNewest(x,
      action('2026-07-03', 'Committee', null, 'Referred to the Committee on Rules.',
        '\n        <committees><item><systemCode>hsru00</systemCode><name>Committee on Rules</name></item></committees>')))).toBe('Reported')
  })

  it('moves a failed bill on when it is later referred or reported', async () => {
    expect(await statusOf('hr9238', 'HB9238', x => withNewest(x,
      action('2026-07-03', 'Committee', null, 'Referred to the Committee on Rules.',
        '\n        <committees><item><systemCode>hsru00</systemCode><name>Committee on Rules</name></item></committees>')))).toBe('In committee')
  })

  it('does not let a failed vote undo a bill that has passed a chamber', async () => {
    expect(await statusOf('hr5185', 'HB5185', x => withNewest(x,
      action('2026-09-01', 'Floor', '9000', 'Failed of passage/not agreed to in House.')))).toBe('Passed House')
  })

  it('reads a concurrent resolution one chamber passed as Passed House, and both as Agreed to', async () => {
    expect(await statusOf('hconres74', 'HCR74', x => withoutCode(x, '17000'))).toBe('Passed House')
  })

  it('stops reading actions once a resolution is agreed to', async () => {
    expect(await statusOf('sres611', 'SR611', x => withNewest(x,
      action('2026-10-01', 'Committee', null, 'Referred to the Committee on Rules.',
        '\n        <committees><item><systemCode>ssru00</systemCode><name>Rules</name></item></committees>')))).toBe('Agreed to')
  })

  it('never reads an action\'s text: a rejected motion in the text leaves a discharged resolution at Reported', async () => {
    // SJRes 133: discharged from committee, then "Motion to proceed ... rejected" in text only.
    expect(await statusOf('sjres133', 'SJR133', x => x)).toBe('Reported')
    expect(xml('sjres133')).toMatch(/Motion to proceed to consideration of measure rejected/)
  })
})

describe('the credit', () => {
  it('names GovInfo, GPO, the Library of Congress, the House Clerk, and the Senate, and links GovInfo', async () => {
    await claim()
    const events = await getJson('/tenants/usteam/body-events?from=2026-09-01&to=2026-09-30')
    expect(events.attribution).toEqual({ providers: [expect.objectContaining({
      id: 'govinfo',
      name: 'GovInfo Bill Status (GPO and Library of Congress), public domain; roll calls from the House Clerk and the Senate',
      url: 'https://www.govinfo.gov/bulkdata/BILLSTATUS',
      note: 'Bill data from GovInfo Bill Status (GPO and Library of Congress), public domain; roll calls from the House Clerk and the Senate.',
    })] })
    // The credit never says FloorVote publishes official data.
    expect(JSON.stringify(events.attribution)).not.toMatch(/official/i)
  })

  it('credits LegiScan for Congress until it is claimed', async () => {
    const events = await getJson('/tenants/usteam/body-events?from=2026-09-01&to=2026-09-30')
    expect(events.attribution.providers.map((p: any) => p.id)).toEqual(['legiscan'])
  })
})

describe('failing closed', () => {
  async function nothingWritten(run: Run) {
    expect(await db().select().from(schema.bills).all()).toEqual([])
    expect(await db().select().from(schema.providerRecords).all()).toEqual([])
    expect(await db().select().from(schema.billTenants).all()).toEqual([])
    expect((await db().select().from(schema.providerIds).all()).filter(r => r.kind === 'bill')).toEqual([])
    expect((await db().select().from(schema.sessions).all()).map(s => s.snapshotEtag ?? null)).toEqual([null])
    expect(run.queue.sendBatch).not.toHaveBeenCalled()
    expect(run.tenantQueue.send).not.toHaveBeenCalled()
    expect(run.tenantQueue.sendBatch).not.toHaveBeenCalled()
  }

  /** Every type's zip good but one, which is broken. Run the sync, which must throw and write nothing. */
  async function breaksWith(type: Type, answer: Served, message: RegExp) {
    await claim()
    answers.set(type, answer)
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow(message)
    await nothingWritten(run)
  }

  describe.each(['hr', 'sconres'] as const)('the %s zip', (type) => {
    const good = () => zipOf(type)
    const cutAt = (at: number) => () => serveZip(good().slice(0, at), { contentLength: null }).response

    it.each([500, 503, 403, 404, 429, 204, 301])('answering %i', async (status) => {
      await breaksWith(type, () => new Response(status === 204 ? null : 'nope', { status }), new RegExp(`GovInfo.*${status}|${status}`))
    })

    it('cut off in the middle of a bill', async () => {
      const layout = zipLayout(good())
      await breaksWith(type, cutAt(layout.entryStarts[layout.entryStarts.length - 1] + 40), /GovInfo/)
    })

    it('cut off after a whole bill, before the central directory', async () => {
      await breaksWith(type, cutAt(zipLayout(good()).centralDirectory), /GovInfo/)
    })

    it('cut off in the central directory, and in its last record', async () => {
      const layout = zipLayout(good())
      await breaksWith(type, cutAt(layout.centralDirectory + 60), /GovInfo/)
      answers.set(type, serve(type))
      await breaksWith(type, cutAt(good().length - 8), /GovInfo/)
    })

    it('shorter than the length it announced', async () => {
      const bytes = good()
      await breaksWith(type, () => serveZip(bytes.slice(0, bytes.length - 100), { contentLength: bytes.length }).response, /GovInfo/)
    })

    it('that is a web page answered with 200', async () => {
      await breaksWith(type, () => new Response('<html><body>Service unavailable</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), /GovInfo.*zip/i)
    })

    it('with a bill that isn\'t valid XML', async () => {
      const prefix = type === 'hr' ? 'hr' : 'sconres'
      const entries = [...files].filter(([n]) => fileType(n) === type).map(([name, data]) => ({ name, data }))
      entries[entries.length - 1] = { name: `BILLSTATUS-119${prefix}99999.xml`, data: '<billStatus><bill><number>1</number>' }
      await breaksWith(type, () => serveZip(buildZip(entries)).response, /GovInfo/)
    })

    it.each([
      ['text that isn\'t XML', 'this is not a bill'],
      ['XML that isn\'t Bill Status', '<?xml version="1.0"?><html><body>hi</body></html>'],
      ['a Bill Status file with no bill', '<billStatus><version>3.0.0</version></billStatus>'],
      ['a bill with no number', '<billStatus><bill><type>HR</type><congress>119</congress></bill></billStatus>'],
      ['a bill of another type', xml('s5531')],
      ['a bill of another Congress', xml('hr3132').replace('<congress>119</congress>', '<congress>118</congress>')],
    ])('with %s in place of a bill', async (_what, data) => {
      const entries = [...files].filter(([n]) => fileType(n) === type).map(([name, d]) => ({ name, data: d }))
      entries.splice(1, 0, { name: `BILLSTATUS-119${type}77777.xml`, data })
      await breaksWith(type, () => serveZip(buildZip(entries)).response, /GovInfo/)
    })
  })

  it('fails on one bad zip among the eight even when the other seven read fine, with nothing from the seven kept', async () => {
    for (const type of BILL_TYPES) {
      await resetCentral()
      calls = []
      await seam.addTenant('US', ['choice for veterans'])
      serveAll()
      await breaksWith(type, () => new Response('', { status: 500 }), /500/)
    }
  })

  it('keeps what an earlier pass stored when a later one fails, and says nothing to instances', async () => {
    await claim()
    await syncAndIngest()
    const hashes = (await db().select().from(schema.providerRecords).all()).map(r => [r.billId, r.rawHash]).sort()
    const stored = await bill('HB3132')

    files.set(file('hr3132'), xml('hr3132').replace('Veterans Act of 2025</title>', 'Veterans Act of 2026</title>'))
    serveAll()
    answers.set('sres', () => new Response('', { status: 502 }))
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow(/502/)
    expect((await db().select().from(schema.providerRecords).all()).map(r => [r.billId, r.rawHash]).sort()).toEqual(hashes)
    expect(await bill('HB3132')).toEqual(stored)
    expect(queuedIds(run)).toEqual([])
    expect(sentToTenant(run)).toEqual([])
  })

  it('reads an empty zip as a type with no bills yet, never as bills removed', async () => {
    await claim()
    await syncAndIngest()
    answers.set('sconres', () => serveZip(buildZip([])).response)
    const run = makeRun()
    await sync(run)
    // Nothing was removed.
    expect(await bill('SCR5')).toMatchObject({ number: 'SCR5', status: 'In committee' })
    expect(sentToTenant(run)).toEqual([])
  })
})

describe('reading the zips as a stream', () => {
  it('never reads a zip whole: every way of doing so throws, and the sync still completes', async () => {
    await claim()
    const run = makeRun()
    const reports = await sync(run)
    expect(reports).toEqual([expect.objectContaining({ sessionName: '119th Congress', records: BILLS.length })])
  })

  it('reads one zip at a time, each fully before the next is requested', async () => {
    await claim()
    const order: string[] = []
    for (const t of BILL_TYPES) {
      const inner = serve(t)
      answers.set(t, () => { order.push(`open ${t}`); const r = inner(); return r })
    }
    await sync()
    expect(order).toEqual(BILL_TYPES.map(t => `open ${t}`))
    expect(calls.map(c => c.url)).toEqual(BILL_TYPES.map(t => zipUrl(t)))
  })

  it('logs each download as a GovInfo call outside the LegiScan budget', async () => {
    await claim()
    await sync()
    // The log is written as the calls go out, without waiting.
    await vi.waitFor(async () => {
      const logged = await db().select().from(schema.apiCallLog).all()
      expect(logged.filter(r => r.callType.startsWith('govinfo:'))).toHaveLength(BILL_TYPES.length)
      expect(logged.filter(r => !r.callType.includes(':'))).toEqual([])
    })
  })
})
