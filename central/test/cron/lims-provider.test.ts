import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'
import detailsHnRaw from '../fixtures/lims/details-HN26-0171.json?raw'
import detailsReprogRaw from '../fixtures/lims/details-REPROG26-0153.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'
import { listedOnlyDetails } from '../helpers/limsListedOnly'

// DC from LIMS at the main seam (#294): LIMS's recorded responses in, with the
// network stubbed at fetch, and central's bill API, its labels, and the
// notifications queued for tenants out.
vi.mock('../../src/lib/rateLimitedFetch', () => import('../helpers/unpacedFetch'))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { lims } from '../../src/providers/lims'
import { limsBillId, limsPeopleId } from '../../src/providers/lims/ids'
import { toLegacyHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral, type Run } from '../helpers/mainSeam'

const LIMS = 'https://lims.dccouncil.gov/api/v2/PublicData/'
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const bulk = JSON.parse(bulkRaw) as Record<string, Record<string, unknown>>
const members = JSON.parse(membersRaw) as { id: number; name: string }[]
const CP26 = { councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }
const CP27 = { councilPeriodId: 27, councilPeriod: '27 (2027-28)', startDate: '2027-01-02T00:00:00', endDate: '2028-12-31T00:00:00' }
/** The default LIMS_CATEGORIES, by the category name BulkData records carry. */
const CATEGORY_IDS: Record<string, number> = {
  'Bill': 1, 'Resolution': 6, 'Grant Budget Modification': 13, 'Reprogramming': 14, 'Oversight Hearing/Roundtable Notice': 18,
}
const B0400 = limsBillId('B26-0400')!
const HN = limsBillId('HN26-0171')!
const REPROG = limsBillId('REPROG26-0153')!

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What the stubbed LIMS answers, by path under PublicData/. A test replaces entries to break it. */
let feed: Record<string, () => Response>
/** Every URL requested. */
let calls: string[]

function recordedFeed(): Record<string, () => Response> {
  const routes: Record<string, () => Response> = {
    'CouncilPeriods': () => json([CP26]),
    'Members/26': () => json(members),
    'LegislationDetails/B26-0400': () => json(JSON.parse(details0400Raw)),
    'LegislationDetails/HN26-0171': () => json(JSON.parse(detailsHnRaw)),
    'LegislationDetails/REPROG26-0153': () => json(JSON.parse(detailsReprogRaw)),
    'LegislationDetails/B26-0001': () => json(listedOnlyDetails('B26-0001', 80)),
    'LegislationDetails/B26-0769': () => json(listedOnlyDetails('B26-0769', 81)),
    'LegislationDetails/PR26-0808': () => json(listedOnlyDetails('PR26-0808', 82)),
    'LegislationDetails/GBM26-0061': () => json(listedOnlyDetails('GBM26-0061', 83)),
  }
  for (const [name, id] of Object.entries(CATEGORY_IDS)) {
    routes[`BulkData/${id}/26`] = () => json(Object.values(bulk).filter(r => r.legislationCategory === name))
  }
  return routes
}

// LIMS's ingests go to its own queue (`run.queue`, LIMS_INGESTOR_QUEUE), not INGESTOR_QUEUE.
const seam = mainSeam(lims, { tenantId: 'oca', env: { LIMS_API_KEY: 'lims-key' } })
const { makeRun, queuedIds, sentToTenant, central, getJson, sync, syncAndIngest } = seam

async function claimDc() {
  expect((await seam.claim('DC')).status).toBe(200)
}

/** One ingest of a bill, and its message, unchecked. */
async function ingest(billId: number, run = makeRun()) {
  return (await seam.ingest(billId, run))[0]
}

beforeEach(async () => {
  await resetCentral()
  feed = recordedFeed()
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url.startsWith(LIMS)) return feed[url.slice(LIMS.length)]?.() ?? new Response('not found', { status: 404 })
    if (url.startsWith('https://lims.dccouncil.gov/downloads/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    throw new Error(`no network in this test: ${url}`)
  })
  await seam.addTenant('DC', ['neglect', 'behavioral health', 'youth rehabilitation'])
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DC from LIMS', () => {
  it('stays off until DC is claimed, even with the LIMS key set', async () => {
    const run = makeRun()
    expect(await sync(run)).toEqual([])
    expect(calls).toEqual([])
    expect((await getJson('/bills/labels?state=DC')).calendarName).toBeNull()
  })

  it('syncs DC from LIMS once claimed, and serves each bill with DC\'s own data', async () => {
    await claimDc()
    const { run, messages } = await syncAndIngest()
    for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
    // Every listed bill: LIMS declares ingestAll (#835).
    expect(queuedIds(run).sort()).toEqual(Object.keys(bulk).map(n => limsBillId(n)!).sort())
    expect(run.ingestor.sendBatch).not.toHaveBeenCalled()

    const bill = await getJson(`/bills/${toLegacyHandle(B0400)}`)
    // The id a fork's production already gave B26-0400, packed from the number.
    expect(bill.billId).toBe('legiscan:1012600400')
    expect(bill).toMatchObject({
      number: 'B26-0400', state: 'DC', status: 'Official Law', statusStage: 'enacted', statusRank: 705, billType: 'Permanent Bill',
    })
    expect(bill.sponsors.map((s: any) => [s.name, s.primary])).toEqual([['Zachary Parker', true], ['Anita Bonds', false]])

    // Committee prints are texts. Reports, notices, records, and memos are supplements, under their types.
    expect(bill.texts.map((t: any) => t.note)).toEqual(expect.arrayContaining(['Introduced', 'Committee Print', 'Engrossed', 'Enrolled', 'Signed Act']))
    expect(bill.supplements.map((s: any) => s.type)).toEqual(expect.arrayContaining(['Committee Report', 'Hearing Notice', 'Hearing Record', 'Memorandum', 'Other']))
    // A document typed only "Other" is titled from its file.
    expect(bill.supplements.filter((s: any) => s.type === 'Other').map((s: any) => s.title).sort())
      .toEqual(['Law Notice 26-129', 'REIA B26-0400 Statutory Neglect Print', 'Request to Agendize'])

    // Each Councilmember's vote on each floor reading.
    const firstReading = bill.votes.find((v: any) => v.date === '2026-03-03')
    expect(firstReading.legislatorVotes).toHaveLength(13)
    expect(firstReading.legislatorVotes).toContainEqual({ personId: String(limsPeopleId(194)), name: 'Zachary Parker', vote: 'Yes', url: null, party: null })

    // Hearing, mark-up, and reading videos, on the history entries they record.
    expect(bill.actions.filter((a: any) => a.videoUrl).map((a: any) => [a.date, a.description.trim(), a.videoUrl])).toEqual([
      ['2025-11-13', 'Public Hearing on B26-0400 View Public Hearing Record', 'http://video.oct.dc.gov/VOD/DCC/2025_11/11_13_25_Youth_Judici.html'],
      ['2026-01-27', 'Committee Mark-up of B26-0400 by the Youth Affairs Committee', 'http://video.oct.dc.gov/VOD/DCC/2026_01/01_27_26_Youth.html'],
      ['2026-02-23', 'Committee Mark-up of B26-0400 by the Judiciary and Public Safety Committee', 'http://video.oct.dc.gov/VOD/DCC/2026_02/02_23_26_Judici.html'],
      ['2026-03-03', 'First Reading, CC', 'https://dc.granicus.com/player/clip/10385?view_id=2&redirect=true'],
      ['2026-03-31', 'Final Reading, CC', 'https://dc.granicus.com/player/clip/10467?view_id=2&redirect=true'],
    ])

    // The extras panel, titled with the provider's name, in vocabulary order.
    expect(bill.extras.providerName).toBe('DC Council')
    // The ten review dates that repeat the timeline are no longer served, and each field says where the page shows it.
    expect(bill.extras.fields.map((f: any) => [f.label, f.value, f.placement])).toEqual([
      ['D.C. Law number', 'L26-0129', 'meta'],
      ['Act number', 'A26-0309', 'meta'],
      ['Law effective', '2026-06-11', 'meta'],
    ])
    // The Mayor's deadline is still a calendar entry, with the id it had.
    expect(bill.calendar.filter((c: any) => c.type === 'Deadline').map((c: any) => [c.date, c.description])).toEqual([['2026-04-28', "Mayor's response due"]])

    const reprogramming = await getJson(`/bills/${toLegacyHandle(REPROG)}`)
    expect(reprogramming).toMatchObject({ status: 'New', statusStage: 'introduced', billType: 'Reprogramming' })
    expect(reprogramming.extras.fields.map((f: any) => [f.key, f.value, f.placement])).toEqual([
      ['requestedBy', 'Mayor', 'meta'],
      ['commentCommittees', 'Youth Affairs', 'detail'],
    ])
    const notice = await getJson(`/bills/${toLegacyHandle(HN)}`)
    expect(notice).toMatchObject({ status: 'Not Applicable', statusStage: null, statusRank: 0 })
    expect(notice.calendar).toEqual([expect.objectContaining({ date: '2026-10-02', location: 'Committee on Health' })])
    expect(notice.extras).toBeNull()

    // Each tracked bill reaches the tenant as a full ingest.
    const full = sentToTenant(run).filter((m: any) => !m.stubOnly).map((m: any) => m.billId)
    expect(full).toEqual(expect.arrayContaining([toLegacyHandle(B0400), toLegacyHandle(HN), toLegacyHandle(REPROG)]))
    expect(calls.filter(u => !u.includes('lims.dccouncil.gov'))).toEqual([])
  })

  it('maps every category the default LIMS_CATEGORIES pull, to a bill type and status DC\'s labels list', async () => {
    await claimDc()
    await syncAndIngest()
    expect(calls.filter(u => u.includes('/BulkData/')).map(u => u.split('/BulkData/')[1]).sort())
      .toEqual(['1/26', '13/26', '14/26', '18/26', '6/26'])

    const labels = await getJson('/bills/labels?state=DC')
    const types = new Set(labels.billTypes.map((t: any) => t.value.toLowerCase()))
    const statuses = new Set(labels.statuses.map((s: any) => s.label))
    for (const number of Object.keys(bulk)) {
      const bill = await getJson(`/bills/${toLegacyHandle(limsBillId(number)!)}`)
      expect(types.has(String(bill.billType).toLowerCase()), `${number}: ${bill.billType}`).toBe(true)
      expect(statuses.has(bill.status), `${number}: ${bill.status}`).toBe(true)
    }
  })

  it('keeps a bill\'s stored votes when LIMS later answers its details with no actions', async () => {
    await claimDc()
    await syncAndIngest()
    const stored = async () => ({
      rolls: (await env.DB.prepare('SELECT roll_call_id AS id FROM roll_calls WHERE bill_id = ? ORDER BY 1').bind(B0400).all<{ id: number }>()).results.map(r => r.id),
      members: (await env.DB.prepare(`SELECT COUNT(*) AS n FROM roll_call_votes WHERE roll_call_id IN (SELECT roll_call_id FROM roll_calls WHERE bill_id = ?)`).bind(B0400).first<{ n: number }>())!.n,
    })
    const before = await stored()
    expect(before.rolls.length).toBeGreaterThan(0)
    expect(before.members).toBeGreaterThan(0)

    // The details come back with no actions (as HN26-0171's do), so the measure has no votes.
    feed['LegislationDetails/B26-0400'] = () => json({ ...JSON.parse(details0400Raw), actions: null })
    expect((await ingest(B0400)).retry).not.toHaveBeenCalled()
    expect(await stored()).toEqual(before)
    expect((await getJson(`/bills/${toLegacyHandle(B0400)}`)).votes.length).toBe(before.rolls.length)
  })

  it('keeps a meeting video only as an http(s) link', async () => {
    const details = JSON.parse(details0400Raw)
    details.committeeHearing[0].videoLink = 'javascript:alert(1)'
    feed['LegislationDetails/B26-0400'] = () => json(details)
    await claimDc()
    await syncAndIngest()
    const bill = await getJson(`/bills/${toLegacyHandle(B0400)}`)
    expect(bill.actions.find((a: any) => a.date === '2025-11-13').videoUrl).toBeNull()
    expect(bill.actions.filter((a: any) => a.videoUrl)).toHaveLength(4)
  })

  it('stages an expired act as enacted, after Official Law', async () => {
    feed['BulkData/1/26'] = () => json([{ ...bulk['B26-0001'], status: 'Expired' }])
    feed['LegislationDetails/B26-0001'] = () => json({ ...listedOnlyDetails('B26-0001', 80), status: 'Expired' })
    await claimDc()
    await syncAndIngest()
    expect(await getJson(`/bills/${toLegacyHandle(limsBillId('B26-0001')!)}`))
      .toMatchObject({ status: 'Expired', statusStage: 'enacted', statusRank: 706 })
  })

  it('keeps a sponsor who has left the Council, on a bill from the previous Council Period', async () => {
    vi.setSystemTime(new Date('2027-03-02T10:00:00Z'))   // 5 ET, in Council Period 27
    feed['CouncilPeriods'] = () => json([CP26, CP27])
    feed['Members/27'] = () => json(members.filter(m => m.name !== 'Zachary Parker'))
    for (const id of Object.values(CATEGORY_IDS)) {
      feed[`BulkData/${id}/26`] = () => json(null)
      feed[`BulkData/${id}/27`] = () => json(null)
    }
    feed['BulkData/1/26'] = () => json([bulk['B26-0400']])
    await claimDc()
    const { messages } = await syncAndIngest()
    expect(messages.map(m => m.body.billId)).toEqual([B0400])

    expect(calls).toEqual(expect.arrayContaining([`${LIMS}Members/26`, `${LIMS}Members/27`]))
    const bill = await getJson(`/bills/${toLegacyHandle(B0400)}`)
    expect(bill.sponsors.map((s: any) => s.name)).toEqual(['Zachary Parker', 'Anita Bonds'])
  })

  it('re-ingests a tenant\'s DC bills on the LIMS queue, with no LegiScan call, for a mapping change', async () => {
    await claimDc()
    await syncAndIngest()
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values({ billId: 2_000_001, sessionId: 2100, state: 'DC', stateId: 51, billNumber: 'B1', changeHash: 'h', title: 't', provider: 'legiscan' } as any)
    await db.insert(schema.billTenants).values({ billId: 2_000_001, tenantId: 'oca', matchType: 'manual' })

    const dry = await central('POST', '/admin/reingest-tenant/oca?provider=lims', makeRun())
    expect(await dry.json()).toMatchObject({ provider: 'lims', matched: 3, wouldQueue: 3, dryRun: true })
    const run = makeRun()
    const res = await central('POST', '/admin/reingest-tenant/oca?provider=lims&confirm=true', run)
    expect(await res.json()).toMatchObject({ provider: 'lims', queued: 3, dryRun: false })
    expect(queuedIds(run).sort()).toEqual([B0400, HN, REPROG].sort())
    expect(run.ingestor.sendBatch).not.toHaveBeenCalled()
    expect((await central('POST', '/admin/reingest-tenant/oca?provider=nope', makeRun())).status).toBe(400)

    // Without its key, LIMS can't ingest anything, so nothing is queued.
    const unkeyed = makeRun()
    unkeyed.env.LIMS_API_KEY = undefined
    const refused = await central('POST', '/admin/reingest-tenant/oca?provider=lims&confirm=true', unkeyed)
    expect(refused.status).toBe(409)
    expect(unkeyed.queue.sendBatch).not.toHaveBeenCalled()
  })
})

describe('committees from LIMS (#299)', () => {
  it('refers each measure to the Council\'s committees, by their full names', async () => {
    await claimDc()
    await syncAndIngest()

    // LegislationDetails names them "Youth Affairs" and "Judiciary and Public Safety".
    const bill = await getJson(`/bills/${toLegacyHandle(B0400)}`)
    expect(bill.committee).toBeNull()
    expect(bill.referrals.map((r: any) => [r.date, r.name, r.chamber])).toEqual([
      ['2025-10-07', 'Committee on Youth Affairs', 'C'],
      ['2025-10-07', 'Committee on Judiciary and Public Safety', 'C'],
    ])
    // Minted from central's id table, clear of LegiScan's ids and LIMS's packed ranges.
    for (const r of bill.referrals) expect(Number(r.committeeId)).toBeGreaterThan(3_000_000_000)

    const notice = await getJson(`/bills/${toLegacyHandle(HN)}`)
    expect(notice.referrals).toEqual([expect.objectContaining({ name: 'Committee on Health', committeeId: expect.any(String) })])

    // "Retained by the Council" names no committee. The committee asked for
    // comments stays an extra, not a referral.
    const reprogramming = await getJson(`/bills/${toLegacyHandle(REPROG)}`)
    expect(reprogramming.referrals).toEqual([{ date: '2026-09-25', committeeId: null, name: 'Retained by the Council', chamber: 'C' }])

    const rows = await drizzle(env.DB, { schema }).select().from(schema.committees).all()
    expect(rows.map(r => [r.name, r.provider, r.state]).sort()).toEqual([
      ['Committee on Health', 'lims', 'DC'],
      ['Committee on Judiciary and Public Safety', 'lims', 'DC'],
      ['Committee on Youth Affairs', 'lims', 'DC'],
    ])
  })

  it('points every measure referred to one committee at the same row, however LIMS spells it', async () => {
    feed['LegislationDetails/HN26-0171'] = () => json({ ...JSON.parse(detailsHnRaw), committeesReferredTo: ['youth  affairs'] })
    await claimDc()
    await syncAndIngest()
    const youth = (await getJson(`/bills/${toLegacyHandle(B0400)}`)).referrals[0]
    const notice = (await getJson(`/bills/${toLegacyHandle(HN)}`)).referrals[0]
    expect(notice.committeeId).toBe(youth.committeeId)
    expect(notice.name).toBe(youth.name)

    // The ids hold across ingests.
    await ingest(B0400)
    expect((await getJson(`/bills/${toLegacyHandle(B0400)}`)).referrals[0].committeeId).toBe(youth.committeeId)
  })
})

describe('DC from LIMS fails closed', () => {
  /** A synced and ingested DC, and what central serves for it. */
  async function baseline() {
    await claimDc()
    await syncAndIngest()
    return {
      bill: await getJson(`/bills/${toLegacyHandle(B0400)}`),
      sessions: await getJson('/bills/sessions?state=DC'),
    }
  }

  const broken: [string, () => Response][] = [
    ['an HTTP error', () => new Response('busy', { status: 503 })],
    ['a body that isn\'t JSON', () => new Response('<html>Down for maintenance</html>', { headers: { 'content-type': 'text/html' } })],
    ['an error object instead of a list', () => json({ message: 'An error has occurred.' })],
  ]

  it.each([
    ...broken,
    ['a record without its number', () => json([{ ...bulk['B26-0400'], legislationNumber: undefined }, bulk['B26-0769']])],
    ['a record whose history isn\'t a list', () => json([{ ...bulk['B26-0400'], legislationHistory: 'none' }])],
    ['a record without its history', () => {
      const { legislationHistory: _h, ...rest } = bulk['B26-0400']
      return json([rest, bulk['B26-0769']])
    }],
  ] as [string, () => Response][])('changes nothing when BulkData answers with %s', async (_what, answer) => {
    const before = await baseline()
    feed['BulkData/1/26'] = answer
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow(/LIMS/)
    expect(run.queue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toLegacyHandle(B0400)}`)).toEqual(before.bill)
  })

  it.each([
    ['an empty list', () => json([])],
    ['null', () => json(null)],
  ] as [string, () => Response][])('reads BulkData answering with %s as nothing new, never as measures removed', async (_what, answer) => {
    const before = await baseline()
    for (const id of Object.values(CATEGORY_IDS)) feed[`BulkData/${id}/26`] = answer
    const run = makeRun()
    await sync(run)
    expect(run.queue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toLegacyHandle(B0400)}`)).toEqual(before.bill)
  })

  it.each([
    ...broken,
    ['a period without its dates', () => json([{ councilPeriodId: 26 }])],
  ] as [string, () => Response][])('changes nothing when CouncilPeriods answers with %s', async (_what, answer) => {
    const before = await baseline()
    feed['CouncilPeriods'] = answer
    calls = []
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow(/LIMS/)
    expect(calls.filter(u => u.includes('/BulkData/'))).toEqual([])
    expect(run.queue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson('/bills/sessions?state=DC')).toEqual(before.sessions)
    expect(await getJson(`/bills/${toLegacyHandle(B0400)}`)).toEqual(before.bill)
  })

  it('keeps its Council Periods when CouncilPeriods answers with an empty list', async () => {
    const before = await baseline()
    feed['CouncilPeriods'] = () => json([])
    calls = []
    const run = makeRun()
    await sync(run)
    expect(await getJson('/bills/sessions?state=DC')).toEqual(before.sessions)
    // The stored period still syncs.
    expect(calls.some(u => u.endsWith('/BulkData/1/26'))).toBe(true)
    expect(sentToTenant(run)).toEqual([])
  })

  it.each([
    ...broken,
    ['a member without an id', () => json([{ name: 'Phil Mendelson' }])],
  ] as [string, () => Response][])('changes nothing when Members answers with %s', async (_what, answer) => {
    const before = await baseline()
    feed['Members/26'] = answer
    const run = makeRun()
    await expect(sync(run)).rejects.toThrow(/LIMS/)
    expect(run.queue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toLegacyHandle(B0400)}`)).toEqual(before.bill)
  })

  it('keeps syncing when Members answers null, as a period not yet seated might', async () => {
    const before = await baseline()
    feed['Members/26'] = () => json(null)
    calls = []
    const run = makeRun()
    await sync(run)
    expect(calls.some(u => u.endsWith('/BulkData/1/26'))).toBe(true)
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toLegacyHandle(B0400)}`)).toEqual(before.bill)
  })

  it.each([
    ...broken,
    ['null', () => json(null)],
    ['an empty object', () => json({})],
    ['only its number', () => json({ legislationNumber: 'B26-0400' })],
    ['its sponsors missing', () => {
      const { introducers: _i, coIntroducers: _c, ...rest } = JSON.parse(details0400Raw)
      return json(rest)
    }],
    ['a list', () => json([JSON.parse(details0400Raw)])],
    ['another measure\'s details', () => json(JSON.parse(detailsHnRaw))],
    ['actions that aren\'t a list', () => json({ ...JSON.parse(details0400Raw), actions: { voteDetails: null } })],
    ['a review that isn\'t an object', () => json({ ...JSON.parse(details0400Raw), mayoralReview: 'pending' })],
  ] as [string, () => Response][])('keeps the bill as it was when LegislationDetails answers with %s', async (_what, answer) => {
    const before = await baseline()
    feed['LegislationDetails/B26-0400'] = answer
    const run = makeRun()
    const message = await ingest(B0400, run)
    expect(message.retry).toHaveBeenCalled()
    expect(message.ack).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toLegacyHandle(B0400)}`)).toEqual(before.bill)
  })
})

describe('DC calendar entries', () => {
  const B0769 = limsBillId('B26-0769')!
  const hearing = (date: string, cancelled = false) => ({
    hearingDate: `${date}T00:00:00`, hearingType: 'Public Hearing', videoLink: null, hearingNotice: null,
    cancellationHearingNotice: cancelled ? 'https://lims.dccouncil.gov/downloads/LIMS/1/Hearing_Cancellation_Notice/B26-0769.pdf?Id=999001' : null,
    noticeFiledDate: null, noticePublicationDate: null, hearingRecord: null,
  })
  const historyRow = (actionDate: string, actionDescription: string) => ({ legislationNumber: 'B26-0769', actionDate, actionDescription, downloadURL: '' })

  /** LIMS serves B26-0769 with this history added, and these hearings in its details. */
  function serve0769(extraHistory: ReturnType<typeof historyRow>[], hearings: ReturnType<typeof hearing>[]) {
    const rec = { ...bulk['B26-0769'], legislationHistory: [...(bulk['B26-0769'].legislationHistory as object[]), ...extraHistory] }
    feed['BulkData/1/26'] = () => json(Object.values(bulk).filter(r => r.legislationCategory === 'Bill' && r.legislationNumber !== 'B26-0769').concat(rec))
    feed['LegislationDetails/B26-0769'] = () => json({
      ...JSON.parse(details0400Raw), legislationNumber: 'B26-0769', status: 'Under Council Review',
      committeeHearing: hearings, committeeMarkup: [], actions: [], otherDocuments: [], mayoralReview: null, congressionalReview: null,
    })
  }
  const SECOND = historyRow('Nov 06, 2026', 'Public Hearing on B26-0769')
  const lastCalendar = (run: Run, billId: number) => sentToTenant(run).filter((m: any) => m.billId === toLegacyHandle(billId) && m.calendar).pop()?.calendar
  const keys = (calendar: any) => calendar.events.map((e: any) => e.identityKey)
  const changeList = (calendar: any) => calendar.changes.map((c: any) => [c.changeType, c.identityKey])
  const billCalendar = async (billId: number) => (await getJson(`/bills/${toLegacyHandle(billId)}`)).calendar.map((c: any) => [c.kind, c.date, c.description])

  beforeEach(async () => {
    // Track B26-0769, whose Council hearing is still to come.
    await drizzle(env.DB, { schema }).insert(schema.keywordRegistry).values({ tenantId: 'oca', keyword: 'soccer' })
  })

  it('keeps each hearing\'s identity when another with the same text is cancelled, and cancels on LIMS\'s notice at once', async () => {
    serve0769([SECOND], [hearing('2026-10-23'), hearing('2026-11-06')])
    await claimDc()
    const { run } = await syncAndIngest()
    const before = lastCalendar(run, B0769)
    expect(keys(before)).toEqual([
      'hearing|2026-10-23|public hearing on b26-0769',
      'hearing|2026-11-06|public hearing on b26-0769',
    ])

    // LIMS cancels the first: a notice in the history, and on the hearing in details.
    serve0769([SECOND, historyRow('Oct 01, 2026', 'Cancellation Notice of Public Hearing filed in the Office of Secretary')],
      [hearing('2026-10-23', true), hearing('2026-11-06')])
    const { run: next } = await syncAndIngest()
    const after = lastCalendar(next, B0769)
    expect(changeList(after)).toEqual([['hearing_cancelled', 'hearing|2026-10-23|public hearing on b26-0769']])
    // The second keeps the identity it had: nothing was numbered by position.
    expect(keys(after)).toEqual(['hearing|2026-11-06|public hearing on b26-0769'])
    expect(await billCalendar(B0769)).toEqual([['hearing', '2026-11-06', 'Public Hearing on B26-0769']])
  })

  it('cancels a hearing that leaves the history with no notice only after two pulls, the second a sync that finds nothing new', async () => {
    serve0769([SECOND], [hearing('2026-10-23'), hearing('2026-11-06')])
    await claimDc()
    await syncAndIngest()

    serve0769([], [hearing('2026-10-23'), hearing('2026-11-06')])
    const { run: once } = await syncAndIngest()
    expect(changeList(lastCalendar(once, B0769))).toEqual([])
    expect(keys(lastCalendar(once, B0769))).toHaveLength(2)

    // Details fetched just now by D1's clock (which the fake one doesn't move), so no details refresh joins in.
    await env.DB.prepare(`UPDATE provider_records SET details_fetched_at = datetime('now')`).run()
    const { run: twice, messages } = await syncAndIngest()
    expect(messages.map(m => m.body)).toEqual([{ billId: B0769, calendarRecheck: expect.any(String) }])
    // A recheck asks LIMS for nothing: the record it stored is the record LIMS still serves.
    expect(calls.filter(u => u.includes('LegislationDetails/B26-0769'))).toHaveLength(2)
    expect(changeList(lastCalendar(twice, B0769))).toEqual([['hearing_cancelled', 'hearing|2026-11-06|public hearing on b26-0769']])
    expect(await billCalendar(B0769)).toEqual([['hearing', '2026-10-23', 'Public Hearing on B26-0769']])
  })

  it('puts DC\'s deadlines on the calendar as deadline entries', async () => {
    await claimDc()
    // B26-0769 has no recorded details here, so its ingest retries. This test is about B26-0400.
    const { run } = await syncAndIngest(makeRun(), { allowRetries: true })
    expect(await billCalendar(B0400)).toContainEqual(['deadline', '2026-04-28', 'Mayor\'s response due'])
    expect(lastCalendar(run, B0400).events).toContainEqual(expect.objectContaining({
      identityKey: 'id:deadline:mayor-response', kind: 'deadline', description: 'Mayor\'s response due',
    }))
    const labels = await getJson('/bills/labels?state=DC')
    expect(labels.eventTypes).toContainEqual({ typeId: 10, label: 'Deadline', kind: 'deadline', explainer: expect.any(String) })
  })

  it('keeps the identities DC subscribers already have for entries stored before identities were, ordinal and all', async () => {
    serve0769([SECOND], [hearing('2026-10-23'), hearing('2026-11-06')])
    await claimDc()
    await syncAndIngest()
    // What a fork's central holds after migration 0034: rows the old ingest
    // wrote, with no identity stored, and the second same-text hearing
    // numbered by position, as instances' calendar UIDs still are.
    await env.DB.prepare('UPDATE bill_calendar SET identity_key = NULL').run()
    await env.DB.prepare(`UPDATE bill_calendar SET description = description || ' (2)', event_hash = 'old-hash' WHERE bill_id = ? AND date = '2026-11-06'`).bind(B0769).run()

    const run = makeRun()
    await ingest(B0769, run)
    const calendar = lastCalendar(run, B0769)
    expect(keys(calendar)).toEqual(['1|public hearing on b26-0769', '1|public hearing on b26-0769 (2)'])
    // The ordinal leaves the description, which instances see as a change, not a cancellation.
    expect(changeList(calendar)).toEqual([['hearing_changed', '1|public hearing on b26-0769 (2)']])
    expect(await billCalendar(B0769)).toEqual([
      ['hearing', '2026-10-23', 'Public Hearing on B26-0769'],
      ['hearing', '2026-11-06', 'Public Hearing on B26-0769'],
    ])
  })
})
