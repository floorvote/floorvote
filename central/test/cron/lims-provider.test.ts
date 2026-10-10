import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'
import detailsHnRaw from '../fixtures/lims/details-HN26-0171.json?raw'
import detailsReprogRaw from '../fixtures/lims/details-REPROG26-0153.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'

// DC from LIMS at the main seam (#294): LIMS's recorded responses in, with the
// network stubbed at fetch, and central's bill API, its labels, and the
// notifications queued for tenants out.
vi.mock('../../src/lib/rateLimitedFetch', () => ({
  // Unpaced, so each LIMS call doesn't cost the test a second. Each attempt is still logged.
  rateLimitedFetch: async (url: string, init: RequestInit | undefined, opts: { onRequest?: () => void }) => {
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

import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { processIngestorQueue } from '../../src/queue/processor'
import { lims } from '../../src/providers/lims'
import { limsBillId, limsPeopleId } from '../../src/providers/lims/ids'
import { toHandle } from '../../src/lib/billHandle'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

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
  }
  for (const [name, id] of Object.entries(CATEGORY_IDS)) {
    routes[`BulkData/${id}/26`] = () => json(Object.values(bulk).filter(r => r.legislationCategory === name))
  }
  return routes
}

function makeEnv() {
  const limsQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    limsQueue, ingestor, tenantQueue,
    env: {
      ...(env as any),
      LIMS_API_KEY: 'lims-key',
      LIMS_INGESTOR_QUEUE: limsQueue,
      INGESTOR_QUEUE: ingestor,
      [tenantQueueBindingName('oca')]: tenantQueue,
    },
  }
}
type Run = ReturnType<typeof makeEnv>

const sentToTenant = (run: Run) => [
  ...run.tenantQueue.send.mock.calls.map(c => c[0]),
  ...run.tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
]
const queuedIds = (run: Run) => run.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body.billId as number))

async function central(method: string, path: string, run: Run, body?: unknown) {
  const { app } = await import('../../src/index-legiscan')
  return app.fetch(new Request(`http://central/api${path}`, {
    method,
    headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), run.env)
}

async function getJson(path: string, run = makeEnv()) {
  const res = await central('GET', path, run)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

async function claimDc(run = makeEnv()) {
  const res = await central('POST', '/admin/state-providers/DC', run, { provider: 'lims' })
  expect(res.status).toBe(200)
}

/** The hourly LIMS sync, then the ingest of every bill it queued. */
async function syncAndIngest(run = makeEnv()) {
  const db = drizzle(env.DB, { schema })
  await runSnapshotSync(lims, run.env, db)
  const messages = queuedIds(run).map(billId => ({ body: { billId }, ack: vi.fn(), retry: vi.fn() }))
  if (messages.length > 0) await processIngestorQueue({ messages } as any, run.env, db)
  return { run, messages }
}

async function ingest(billId: number, run = makeEnv()) {
  const message = { body: { billId }, ack: vi.fn(), retry: vi.fn() }
  await processIngestorQueue({ messages: [message] } as any, run.env, drizzle(env.DB, { schema }))
  return message
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))   // 5 ET
  await setupLsDb()
  vi.clearAllMocks()
  feed = recordedFeed()
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url.startsWith(LIMS)) return feed[url.slice(LIMS.length)]?.() ?? new Response('not found', { status: 404 })
    if (url.startsWith('https://lims.dccouncil.gov/downloads/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    throw new Error(`no network in this test: ${url}`)
  })
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'oca', name: 'OCA', stateCoverage: '["DC"]', active: true })
  await db.insert(schema.keywordRegistry).values(['neglect', 'behavioral health', 'youth rehabilitation'].map(keyword => ({ tenantId: 'oca', keyword })))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DC from LIMS', () => {
  it('stays off until DC is claimed, even with the LIMS key set', async () => {
    const run = makeEnv()
    expect(await runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }))).toEqual([])
    expect(calls).toEqual([])
    expect((await getJson('/bills/labels?state=DC')).calendarName).toBeNull()
  })

  it('syncs DC from LIMS once claimed, and serves each bill with DC\'s own data', async () => {
    await claimDc()
    const { run, messages } = await syncAndIngest()
    for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
    expect(queuedIds(run).sort()).toEqual([B0400, HN, REPROG].sort())
    expect(run.ingestor.sendBatch).not.toHaveBeenCalled()

    const bill = await getJson(`/bills/${toHandle(B0400)}`)
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
    expect(firstReading.legislatorVotes).toContainEqual({ personId: String(limsPeopleId(194)), name: 'Zachary Parker', vote: 'Yes' })

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
    expect(bill.extras.fields.map((f: any) => [f.label, f.value])).toEqual([
      ['D.C. Law number', 'L26-0129'],
      ['Act number', 'A26-0309'],
      ['Sent to the Mayor', '2026-04-13'],
      ['Mayor\'s deadline', '2026-04-28'],
      ['Signed by the Mayor', '2026-04-24'],
      ['Enacted', '2026-04-24'],
      ['Sent to Congress', '2026-04-29'],
      ['Law effective', '2026-06-11'],
    ])

    const reprogramming = await getJson(`/bills/${toHandle(REPROG)}`)
    expect(reprogramming).toMatchObject({ status: 'New', statusStage: 'introduced', billType: 'Reprogramming' })
    expect(reprogramming.extras.fields.map((f: any) => [f.key, f.value])).toEqual([
      ['requestedBy', 'Mayor'],
      ['commentCommittees', 'Youth Affairs'],
    ])
    const notice = await getJson(`/bills/${toHandle(HN)}`)
    expect(notice).toMatchObject({ status: 'Not Applicable', statusStage: null, statusRank: 0 })
    expect(notice.calendar).toEqual([expect.objectContaining({ date: '2026-10-02', location: 'Committee on Health' })])
    expect(notice.extras).toBeNull()

    // Each tracked bill reaches the tenant as a full ingest.
    const full = sentToTenant(run).filter((m: any) => !m.stubOnly).map((m: any) => m.billId)
    expect(full).toEqual(expect.arrayContaining([toHandle(B0400), toHandle(HN), toHandle(REPROG)]))
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
      const bill = await getJson(`/bills/${toHandle(limsBillId(number)!)}`)
      expect(types.has(String(bill.billType).toLowerCase()), `${number}: ${bill.billType}`).toBe(true)
      expect(statuses.has(bill.status), `${number}: ${bill.status}`).toBe(true)
    }
  })

  it('keeps a meeting video only as an http(s) link', async () => {
    const details = JSON.parse(details0400Raw)
    details.committeeHearing[0].videoLink = 'javascript:alert(1)'
    feed['LegislationDetails/B26-0400'] = () => json(details)
    await claimDc()
    await syncAndIngest()
    const bill = await getJson(`/bills/${toHandle(B0400)}`)
    expect(bill.actions.find((a: any) => a.date === '2025-11-13').videoUrl).toBeNull()
    expect(bill.actions.filter((a: any) => a.videoUrl)).toHaveLength(4)
  })

  it('stages an expired act as enacted, after Official Law', async () => {
    feed['BulkData/1/26'] = () => json([{ ...bulk['B26-0001'], status: 'Expired' }])
    await claimDc()
    await syncAndIngest()
    expect(await getJson(`/bills/${toHandle(limsBillId('B26-0001')!)}`))
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
    const bill = await getJson(`/bills/${toHandle(B0400)}`)
    expect(bill.sponsors.map((s: any) => s.name)).toEqual(['Zachary Parker', 'Anita Bonds'])
  })

  it('re-ingests a tenant\'s DC bills on the LIMS queue, with no LegiScan call, for a mapping change', async () => {
    await claimDc()
    await syncAndIngest()
    const db = drizzle(env.DB, { schema })
    await db.insert(schema.bills).values({ billId: 2_000_001, sessionId: 2100, state: 'DC', stateId: 51, billNumber: 'B1', changeHash: 'h', title: 't', provider: 'legiscan' } as any)
    await db.insert(schema.billTenants).values({ billId: 2_000_001, tenantId: 'oca', matchType: 'manual' })

    const dry = await central('POST', '/admin/reingest-tenant/oca?provider=lims', makeEnv())
    expect(await dry.json()).toMatchObject({ provider: 'lims', matched: 3, wouldQueue: 3, dryRun: true })
    const run = makeEnv()
    const res = await central('POST', '/admin/reingest-tenant/oca?provider=lims&confirm=true', run)
    expect(await res.json()).toMatchObject({ provider: 'lims', queued: 3, dryRun: false })
    expect(queuedIds(run).sort()).toEqual([B0400, HN, REPROG].sort())
    expect(run.ingestor.sendBatch).not.toHaveBeenCalled()
    expect((await central('POST', '/admin/reingest-tenant/oca?provider=nope', makeEnv())).status).toBe(400)

    // Without its key, LIMS can't ingest anything, so nothing is queued.
    const unkeyed = makeEnv()
    unkeyed.env.LIMS_API_KEY = undefined
    const refused = await central('POST', '/admin/reingest-tenant/oca?provider=lims&confirm=true', unkeyed)
    expect(refused.status).toBe(409)
    expect(unkeyed.limsQueue.sendBatch).not.toHaveBeenCalled()
  })
})

describe('DC from LIMS fails closed', () => {
  /** A synced and ingested DC, and what central serves for it. */
  async function baseline() {
    await claimDc()
    await syncAndIngest()
    return {
      bill: await getJson(`/bills/${toHandle(B0400)}`),
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
    const run = makeEnv()
    await expect(runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }))).rejects.toThrow(/LIMS/)
    expect(run.limsQueue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(B0400)}`)).toEqual(before.bill)
  })

  it.each([
    ['an empty list', () => json([])],
    ['null', () => json(null)],
  ] as [string, () => Response][])('reads BulkData answering with %s as nothing new, never as measures removed', async (_what, answer) => {
    const before = await baseline()
    for (const id of Object.values(CATEGORY_IDS)) feed[`BulkData/${id}/26`] = answer
    const run = makeEnv()
    await runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }))
    expect(run.limsQueue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(B0400)}`)).toEqual(before.bill)
  })

  it.each([
    ...broken,
    ['a period without its dates', () => json([{ councilPeriodId: 26 }])],
  ] as [string, () => Response][])('changes nothing when CouncilPeriods answers with %s', async (_what, answer) => {
    const before = await baseline()
    feed['CouncilPeriods'] = answer
    calls = []
    const run = makeEnv()
    await expect(runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }))).rejects.toThrow(/LIMS/)
    expect(calls.filter(u => u.includes('/BulkData/'))).toEqual([])
    expect(run.limsQueue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson('/bills/sessions?state=DC')).toEqual(before.sessions)
    expect(await getJson(`/bills/${toHandle(B0400)}`)).toEqual(before.bill)
  })

  it('keeps its Council Periods when CouncilPeriods answers with an empty list', async () => {
    const before = await baseline()
    feed['CouncilPeriods'] = () => json([])
    calls = []
    const run = makeEnv()
    await runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }))
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
    const run = makeEnv()
    await expect(runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }))).rejects.toThrow(/LIMS/)
    expect(run.limsQueue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(B0400)}`)).toEqual(before.bill)
  })

  it('keeps syncing when Members answers null, as a period not yet seated might', async () => {
    const before = await baseline()
    feed['Members/26'] = () => json(null)
    calls = []
    const run = makeEnv()
    await runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }))
    expect(calls.some(u => u.endsWith('/BulkData/1/26'))).toBe(true)
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(B0400)}`)).toEqual(before.bill)
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
    const run = makeEnv()
    const message = await ingest(B0400, run)
    expect(message.retry).toHaveBeenCalled()
    expect(message.ack).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    expect(await getJson(`/bills/${toHandle(B0400)}`)).toEqual(before.bill)
  })
})
