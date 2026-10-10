import { env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { setupLsDb } from '../helpers/setupLsDb'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'
import detailsHnRaw from '../fixtures/lims/details-HN26-0171.json?raw'
import detailsReprogRaw from '../fixtures/lims/details-REPROG26-0153.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'
import calendarRaw from '../fixtures/lims/hearings-calendar.json?raw'

// The Council's own calendar at the main seam (#297): LIMS's recorded
// responses and the hearings calendar in, with the network stubbed at fetch,
// and what central serves instances out: their body events, the bill API, and
// the notifications queued for them.
vi.mock('../../src/lib/rateLimitedFetch', () => ({
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
import { runBodyEventSync } from '../../src/cron/body-events'
import { processIngestorQueue } from '../../src/queue/processor'
import { lims } from '../../src/providers/lims'
import { limsBillId } from '../../src/providers/lims/ids'
import { toHandle } from '../../src/lib/billHandle'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

const LIMS = 'https://lims.dccouncil.gov/api/v2/PublicData/'
const HEARINGS = 'https://lims.dccouncil.gov/Hearings/API/Public/GetHearingsCalendar'
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const bulk = JSON.parse(bulkRaw) as Record<string, Record<string, unknown>>
const recordedMonths = JSON.parse(calendarRaw) as Record<string, Record<string, any>[]>
const october = recordedMonths['2026-10']
const CP26 = { councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }
const CATEGORY_IDS: Record<string, number> = {
  'Bill': 1, 'Resolution': 6, 'Grant Budget Modification': 13, 'Reprogramming': 14, 'Oversight Hearing/Roundtable Notice': 18,
}
const B0400 = limsBillId('B26-0400')!
const B0769 = limsBillId('B26-0769')!
const HN = limsBillId('HN26-0171')!
const WINDOW = 'from=2026-08-01&to=2026-12-31'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What the stubbed LIMS answers, by path under PublicData/. */
let feed: Record<string, () => Response>
/** What the hearings calendar answers, by month (YYYY-MM). A month left out answers an empty list. */
let calendar: Record<string, () => Response>
let calls: string[]

function makeEnv() {
  const limsQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    limsQueue, tenantQueue,
    env: {
      ...(env as any),
      LIMS_API_KEY: 'lims-key',
      LIMS_INGESTOR_QUEUE: limsQueue,
      INGESTOR_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() },
      [tenantQueueBindingName('oca')]: tenantQueue,
    },
  }
}
type Run = ReturnType<typeof makeEnv>
const db = () => drizzle(env.DB, { schema })

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

async function claimDc() {
  expect((await central('POST', '/admin/state-providers/DC', makeEnv(), { provider: 'lims' })).status).toBe(200)
}

/** DC's bills synced and ingested, as the hourly LIMS sync leaves them. */
async function syncBills(run = makeEnv()) {
  await runSnapshotSync(lims, run.env, db())
  const messages = run.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))
    .map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
  if (messages.length > 0) await processIngestorQueue({ messages } as any, run.env, db())
  return run
}

/** One hourly sync of the Council's calendar. */
const syncCalendar = (run = makeEnv()) => runBodyEventSync(lims, run.env, db())

async function ingest(billId: number, run = makeEnv()) {
  await processIngestorQueue({ messages: [{ body: { billId }, ack: vi.fn(), retry: vi.fn() }] } as any, run.env, db())
  return run
}

const sentToTenant = (run: Run) => [
  ...run.tenantQueue.send.mock.calls.map(c => c[0]),
  ...run.tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
]

/** The instance's body events, by calendar UID. */
async function eventsFor(tenantId = 'oca') {
  const body = await getJson(`/tenants/${tenantId}/body-events?${WINDOW}`)
  return { ...body, byUid: new Map<string, any>(body.events.map((e: any) => [e.uid, e])) }
}

const withoutEvent = (id: number) => () => json(october.filter(h => h.hearingId !== id))

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))
  await setupLsDb()
  vi.clearAllMocks()
  feed = {
    'CouncilPeriods': () => json([CP26]),
    'Members/26': () => json(JSON.parse(membersRaw)),
    'LegislationDetails/B26-0400': () => json(JSON.parse(details0400Raw)),
    'LegislationDetails/HN26-0171': () => json(JSON.parse(detailsHnRaw)),
    'LegislationDetails/REPROG26-0153': () => json(JSON.parse(detailsReprogRaw)),
    'LegislationDetails/B26-0769': () => json({ ...JSON.parse(details0400Raw), legislationNumber: 'B26-0769', committeeHearing: [], committeeMarkup: [], actions: [], otherDocuments: [] }),
  }
  for (const [name, id] of Object.entries(CATEGORY_IDS)) {
    feed[`BulkData/${id}/26`] = () => json(Object.values(bulk).filter(r => r.legislationCategory === name))
  }
  calendar = { '2026-10': () => json(october) }
  calls = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url === HEARINGS) {
      const { month, year } = JSON.parse(String(init?.body)) as { month: string; year: string }
      return calendar[`${year}-${month.padStart(2, '0')}`]?.() ?? json([])
    }
    if (url.startsWith(LIMS)) return feed[url.slice(LIMS.length)]?.() ?? new Response('not found', { status: 404 })
    if (url.startsWith('https://lims.dccouncil.gov/downloads/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    throw new Error(`no network in this test: ${url}`)
  })
  await db().insert(schema.tenants).values({ tenantId: 'oca', name: 'OCA', stateCoverage: '["DC"]', active: true })
  await db().insert(schema.keywordRegistry).values(['neglect', 'behavioral health', 'soccer stadium'].map(keyword => ({ tenantId: 'oca', keyword })))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the Council\'s calendar', () => {
  it('stays off until DC is claimed', async () => {
    expect(await syncCalendar()).toEqual([])
    expect(calls).toEqual([])
    expect(await eventsFor()).toMatchObject({ capabilities: {}, events: [] })
    expect(await getJson('/bills/labels?state=DC')).toMatchObject({ hasEvents: false, capabilities: { bodyEvents: false, deadlines: false } })
  })

  it('reaches instances covering DC once DC is claimed, each event under the UID a fork already issued', async () => {
    await claimDc()
    await syncBills()
    await syncCalendar()
    // Last month through three ahead, one keyless call each, logged outside the LegiScan budget.
    const months = fetchMock.mock.calls.filter(c => String(c[0]) === HEARINGS).map(c => JSON.parse(String(c[1].body)))
    expect(months.map(m => `${m.year}-${m.month}`)).toEqual(['2026-8', '2026-9', '2026-10', '2026-11', '2026-12'])
    const logged = await db().select().from(schema.apiCallLog).where(eq(schema.apiCallLog.callType, 'lims:HearingsCalendar')).all()
    expect(logged).toHaveLength(5)

    const { capabilities, events, byUid } = await eventsFor()
    expect(capabilities).toEqual({ DC: { bodyEvents: true, deadlines: true } })
    expect(events).toHaveLength(october.length)
    expect(byUid.get('council-2408@lims.dccouncil.gov')).toEqual({
      uid: 'council-2408@lims.dccouncil.gov',
      state: 'DC',
      kind: 'hearing',
      type: 'Roundtable',
      date: '2026-10-01',
      time: '10:00',
      timezone: 'America/New_York',
      committee: { committeeId: expect.any(String), name: 'Committee on Housing' },
      jointWith: null,
      location: 'Room 123 (Track C)',
      title: 'Housing roundtable',
      agenda: [{ topic: 'Improving Housing Conditions and Strengthening Landlord Accountability in the District', billNumber: null }],
      url: 'https://lims.dccouncil.gov/Hearings/hearings/2408',
      eventHash: '78a22f7cd5a0a207615d710558b8f192',
      cancelled: false,
      bills: [],
      covers: [],
    })
    expect(byUid.get('council-2045@lims.dccouncil.gov')).toMatchObject({ kind: 'meeting', title: 'Legislative Meeting', committee: null })

    expect(await getJson('/bills/labels?state=DC')).toMatchObject({ hasEvents: true, capabilities: { bodyEvents: true, deadlines: true } })
  })

  it('links agenda bills, and marks the bill calendar entry the event covers, so the hearing shows once', async () => {
    await claimDc()
    await syncBills()
    await syncCalendar()
    const { byUid } = await eventsFor()

    // By its number: B26-0769's public hearing on October 23.
    expect(byUid.get('council-2405@lims.dccouncil.gov')).toMatchObject({
      bills: [toHandle(B0769)],
      covers: [{ billId: toHandle(B0769), identityKey: 'hearing|2026-10-23|public hearing on b26-0769' }],
    })
    // Without a number: the oversight roundtable whose hearing notice is set for that day.
    expect(byUid.get('council-2428@lims.dccouncil.gov')).toMatchObject({ bills: [toHandle(HN)], covers: [expect.objectContaining({ billId: toHandle(HN) })] })
    // A bill on the agenda with no entry that day is linked and covers nothing.
    expect(byUid.get('council-2413@lims.dccouncil.gov')).toMatchObject({ covers: [] })

    const bill = await getJson(`/bills/${toHandle(B0769)}`)
    expect(bill.calendar).toEqual([expect.objectContaining({ date: '2026-10-23', coveredBy: 'council-2405@lims.dccouncil.gov' })])
    // An entry no event covers says so.
    const b0400 = await getJson(`/bills/${toHandle(B0400)}`)
    expect(b0400.calendar.length).toBeGreaterThan(0)
    for (const entry of b0400.calendar) expect(entry.coveredBy).toBeNull()

    // The notification an ingest sends carries the cover too.
    const run = await ingest(B0769)
    const sent = sentToTenant(run).find((m: any) => m.billId === toHandle(B0769))
    expect(sent.calendar.events).toEqual([expect.objectContaining({ identityKey: 'hearing|2026-10-23|public hearing on b26-0769', coveredBy: 'council-2405@lims.dccouncil.gov' })])
  })

  it('records each committee holding an event, under the id the committee\'s referrals point at', async () => {
    await claimDc()
    await syncBills()
    await syncCalendar()
    const { byUid } = await eventsFor()
    const youthReferral = (await getJson(`/bills/${toHandle(B0400)}`)).referrals.find((r: any) => r.name === 'Committee on Youth Affairs')
    expect(byUid.get('council-2415@lims.dccouncil.gov').committee).toEqual({ committeeId: youthReferral.committeeId, name: 'Committee on Youth Affairs' })

    const rows = await db().select().from(schema.committees).where(eq(schema.committees.name, 'Committee on Human Services')).all()
    expect(rows).toEqual([expect.objectContaining({ state: 'DC', provider: 'lims', chamber: 'C' })])
  })

  it('cancels an event missing from two successful pulls in a row, never on a failed or empty month, and restores it', async () => {
    await claimDc()
    await syncCalendar()
    const uid = 'council-2408@lims.dccouncil.gov'

    calendar['2026-10'] = withoutEvent(2408)
    await syncCalendar()
    expect((await eventsFor()).byUid.get(uid).cancelled).toBe(false)

    // A failed month, an unexpected shape, and an empty month are no pulls at all.
    calendar['2026-10'] = () => new Response('busy', { status: 503 })
    await syncCalendar()
    calendar['2026-10'] = () => json({ unexpected: true })
    await syncCalendar()
    calendar['2026-10'] = () => json([])
    await syncCalendar()
    expect((await eventsFor()).byUid.get(uid).cancelled).toBe(false)

    calendar['2026-10'] = withoutEvent(2408)
    await syncCalendar()
    const after = await eventsFor()
    expect(after.byUid.get(uid).cancelled).toBe(true)
    expect([...after.byUid.values()].filter((e: any) => e.cancelled)).toHaveLength(1)

    calendar['2026-10'] = () => json(october)
    await syncCalendar()
    expect((await eventsFor()).byUid.get(uid)).toMatchObject({ cancelled: false, eventHash: '78a22f7cd5a0a207615d710558b8f192' })
  })

  it('keeps a moved event\'s UID, and changes its hash', async () => {
    await claimDc()
    await syncCalendar()
    const moved = { ...october.find(h => h.hearingId === 2408)!, hearingDateTime: '2026-11-05T14:00:00' }
    calendar['2026-10'] = withoutEvent(2408)
    calendar['2026-11'] = () => json([moved])
    await syncCalendar()
    await syncCalendar()
    const event = (await eventsFor()).byUid.get('council-2408@lims.dccouncil.gov')
    expect(event).toMatchObject({ date: '2026-11-05', time: '14:00', cancelled: false })
    expect(event.eventHash).not.toBe('78a22f7cd5a0a207615d710558b8f192')
  })

  it('serves an instance only the states it covers', async () => {
    await claimDc()
    await syncCalendar()
    await db().insert(schema.tenants).values([
      { tenantId: 'md', name: 'MD', stateCoverage: '["MD"]', active: true },
      { tenantId: 'all', name: 'All', stateCoverage: '["*"]', active: true },
    ])
    expect(await eventsFor('md')).toMatchObject({ capabilities: {}, events: [] })
    expect((await eventsFor('all')).events).toHaveLength(october.length)
    expect((await eventsFor('all')).capabilities).toEqual({ DC: { bodyEvents: true, deadlines: true } })
  })

  it('syncs nothing for a state no instance covers', async () => {
    await claimDc()
    await db().update(schema.tenants).set({ stateCoverage: '["MD"]' })
    expect(await syncCalendar()).toEqual([])
    expect(calls).toEqual([])
  })
})
