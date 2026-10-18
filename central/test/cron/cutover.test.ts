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

// Cutting DC over from LegiScan to LIMS at the main seam (#296): a central
// whose DC bills came from LegiScan and are tracked by an instance, LIMS's
// recorded responses in, and LegiScan's API stubbed at fetch for the undo.
// The checks are on central's admin and bill APIs, and on the notifications
// queued for the instance.
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
// Hooks into the ingest's calendar steps, to land a cutover partway through
// an ingest, or fail one partway. Off unless a test sets them.
const hooks = vi.hoisted(() => ({
  beforeRead: null as null | (() => Promise<void>),
  beforeLog: null as null | (() => Promise<void>),
  /** When set, the hooks above wait for this bill's ingest. */
  bill: null as null | number,
  failWrite: false,
  failVotes: false,
}))
// Fails the member-vote write, which comes after the calendar's.
vi.mock('../../src/lib/rollCallVotes', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/rollCallVotes')>('../../src/lib/rollCallVotes')
  return {
    ...actual,
    writeMemberVotes: async (...args: Parameters<typeof actual.writeMemberVotes>) => {
      if (hooks.failVotes) {
        hooks.failVotes = false
        throw new Error('D1_ERROR: a write failed')
      }
      return actual.writeMemberVotes(...args)
    },
  }
})
vi.mock('../../src/lib/billCalendar', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/billCalendar')>('../../src/lib/billCalendar')
  const once = async (key: 'beforeRead' | 'beforeLog', billId: number) => {
    if (hooks.bill !== null && hooks.bill !== billId) return
    const hook = hooks[key]
    hooks[key] = null
    if (hook) await hook()
  }
  return {
    ...actual,
    readCalendarRows: async (...args: Parameters<typeof actual.readCalendarRows>) => {
      await once('beforeRead', args[1])
      return actual.readCalendarRows(...args)
    },
    logCalendarChanges: async (...args: Parameters<typeof actual.logCalendarChanges>) => {
      await once('beforeLog', args[1])
      return actual.logCalendarChanges(...args)
    },
    writeCalendarRows: async (...args: Parameters<typeof actual.writeCalendarRows>) => {
      if (hooks.failWrite) {
        hooks.failWrite = false
        throw new Error('D1_ERROR: a write failed')
      }
      return actual.writeCalendarRows(...args)
    },
  }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { runSync } from '../../src/cron/sync'
import { processIngestorQueue } from '../../src/queue/processor'
import { getCurrentEtHour } from '../../src/lib/sync-schedule'
import { limsBillId, limsSessionId } from '../../src/providers/lims/ids'
import { toHandle } from '../../src/lib/billHandle'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

const LIMS = 'https://lims.dccouncil.gov/api/v2/PublicData/'
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const bulk = JSON.parse(bulkRaw) as Record<string, Record<string, unknown>>
const CP26 = { councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }
const CATEGORY_IDS: Record<string, number> = {
  'Bill': 1, 'Resolution': 6, 'Grant Budget Modification': 13, 'Reprogramming': 14, 'Oversight Hearing/Roundtable Notice': 18,
}

// LegiScan's DC, as an instance has tracked it.
const LS_SESSION = 2150
const LS_EARLIER = 2100
const B0400 = 1900400        // tracked, with LegiScan's documents, votes, and calendar
const B0001 = 1900001        // a monitor link only
const B9999 = 1909999        // tracked, and LIMS has no such bill
const B0005 = 1800005        // an earlier session's
const PARKER = 25001
const BONDS = 25002
const GONE = 25003

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let feed: Record<string, () => Response>
let calls: string[]

/**
 * B26-0001's details, which weren't recorded: B26-0400's, renumbered, with
 * B26-0001's title and status, no summary, and document ids of its own.
 */
const details0001 = () => ({
  ...JSON.parse(details0400Raw.replaceAll('B26-0400', 'B26-0001').replace(/Id=(\d+)/g, 'Id=9$1')),
  legislationId: 56820, status: 'Enacted', additionalInformation: null,
  title: 'Rent Stabilized Housing Inflation Protection Continuation Emergency Amendment Act of 2025',
})

function recordedFeed(): Record<string, () => Response> {
  const routes: Record<string, () => Response> = {
    'CouncilPeriods': () => json([CP26]),
    'Members/26': () => json(JSON.parse(membersRaw)),
    'LegislationDetails/B26-0400': () => json(JSON.parse(details0400Raw)),
    'LegislationDetails/B26-0001': () => json(details0001()),
    'LegislationDetails/HN26-0171': () => json(JSON.parse(detailsHnRaw)),
    'LegislationDetails/REPROG26-0153': () => json(JSON.parse(detailsReprogRaw)),
  }
  for (const [name, id] of Object.entries(CATEGORY_IDS)) {
    routes[`BulkData/${id}/26`] = () => json(Object.values(bulk).filter(r => r.legislationCategory === name))
  }
  return routes
}

/** Bills filed since, which LegiScan's masterlist adds after its recorded three. */
let filedLater: { billId: number; number: string; title: string }[] = []

/** What LegiScan serves for DC once the state is back on it. */
function legiscan(op: string, id: string | null): unknown {
  const entry = (billId: number, number: string, hash: string, title: string) =>
    ({ bill_id: billId, number, change_hash: hash, title, description: title, status: 1, status_date: '2025-10-06', last_action: 'Introduced', last_action_date: '2025-10-06', url: '' })
  if (op === 'getMasterList' && id === String(LS_SESSION)) {
    return { masterlist: {
      session: { session_id: LS_SESSION, session_name: '2025-2026 Council Period 26' },
      0: entry(B0400, 'B26-0400', 'ls-v2', 'Statutory Neglect Amendment Act of 2025'),
      1: entry(B0001, 'B26-0001', 'ls-v2', 'Something else'),
      // Unchanged, since nothing moved it.
      2: entry(B9999, 'B26-9999', 'ls-v1', 'Youth rehabilitation study'),
      ...Object.fromEntries(filedLater.map((b, i) => [3 + i, entry(b.billId, b.number, 'ls-v1', b.title)])),
    } }
  }
  if (op === 'getBill' && id === String(B0400)) {
    return { bill: {
      bill_id: B0400, change_hash: 'ls-v2', session_id: LS_SESSION, state: 'DC', state_id: 9, bill_number: 'B26-0400',
      bill_type: 'B', bill_type_id: '1', body: 'C', body_id: 1, current_body: 'C', current_body_id: 1,
      title: 'Statutory Neglect Amendment Act of 2025', description: 'Statutory Neglect Amendment Act of 2025', status: 4, status_date: '2026-04-24',
      pending_committee_id: 0, url: 'https://legiscan.com/DC/bill/B26-0400/2025', state_link: 'https://lims.dccouncil.gov/Legislation/B26-0400',
      session: { session_id: LS_SESSION, session_name: '2025-2026 Council Period 26', year_start: 2025, year_end: 2026 },
      committee: [], referrals: [], progress: [], sasts: [], subjects: [], votes: [], amendments: [], supplements: [],
      sponsors: [{ people_id: PARKER, name: 'Zachary Parker', party: 'D', role: 'Rep', role_id: 1, district: 'Ward 5', sponsor_type_id: 1, sponsor_order: 1 }],
      texts: [{ doc_id: 5002, date: '2025-10-06', type: 'Introduced', type_id: 1, mime: 'application/pdf', mime_id: 2, url: '', state_link: 'https://lims.dccouncil.gov/downloads/LIMS/5002.pdf', text_size: 0, text_hash: '', alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '' }],
      history: [{ date: '2025-10-06', action: 'Introduced', chamber: 'C', chamber_id: 1, importance: 1 }],
      calendar: [
        { type_id: 1, type: 'Hearing', date: '2025-11-13', time: '', location: '', description: 'Committee on Youth Affairs', event_hash: 'ls-h1' },
        { type_id: 3, type: 'Markup Session', date: '2026-01-27', time: '', location: '', description: 'Committee on Youth Affairs', event_hash: 'ls-m1' },
      ],
    } }
  }
  throw new Error(`unexpected LegiScan call ${op} ${id}`)
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
const queued = (queue: Run['limsQueue']) => queue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))

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

const cutover = (run: Run, query = '') => central('POST', `/admin/state-providers/DC/cutover${query}`, run, { provider: 'lims' })
const undo = (run: Run, query = '') => central('POST', `/admin/state-providers/DC/undo-cutover${query}`, run)

/** Process every message a queue was sent: each bill's ingest. */
async function drain(queue: Run['limsQueue'], run: Run) {
  const messages = queued(queue).map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
  if (messages.length > 0) await processIngestorQueue({ messages } as any, run.env, drizzle(env.DB, { schema }))
  for (const m of messages) expect(m.retry, `bill ${m.body.billId} retried`).not.toHaveBeenCalled()
  return messages
}

/** Every row of the tables a cutover writes, to check that something wrote nothing. */
async function snapshotTables() {
  const tables = [
    'bills', 'sessions', 'people', 'bill_texts', 'bill_supplements', 'bill_amendments', 'roll_calls', 'roll_call_votes',
    'bill_calendar', 'bill_tenants', 'bill_sponsors', 'provider_ids', 'provider_records', 'state_providers',
    'cutovers', 'cutover_bills', 'cutover_people', 'bill_change_log',
  ]
  const out: Record<string, unknown[]> = {}
  for (const t of tables) out[t] = (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results
  return out
}

async function row<T = any>(sql: string, ...binds: unknown[]): Promise<T> {
  return env.DB.prepare(sql).bind(...binds).first() as Promise<T>
}

const calendarOf = (run: Run, billId: number) => sentToTenant(run).filter((m: any) => m.billId === toHandle(billId) && m.calendar).pop()

async function seedLegiscanDc() {
  const db = drizzle(env.DB, { schema })
  await db.insert(schema.tenants).values({ tenantId: 'oca', name: 'OCA', stateCoverage: '["DC"]', active: true })
  await db.insert(schema.keywordRegistry).values(['neglect', 'behavioral health', 'youth rehabilitation'].map(keyword => ({ tenantId: 'oca', keyword })))
  const session = { state: 'DC', stateId: 9, special: 0, sessionTitle: 'x' }
  await db.insert(schema.sessions).values([
    { ...session, sessionId: LS_SESSION, yearStart: 2025, yearEnd: 2026, sessionName: '2025-2026 Council Period 26', slug: 'cp26' },
    { ...session, sessionId: LS_EARLIER, yearStart: 2023, yearEnd: 2024, sessionName: '2023-2024 Council Period 25', slug: 'cp25', prior: 1, sineDie: 1 },
  ])
  const bill = (billId: number, billNumber: string, title: string, sessionId = LS_SESSION) =>
    ({ billId, billNumber, title, sessionId, state: 'DC', stateId: 9, changeHash: 'ls-v1', status: 1 })
  await db.insert(schema.bills).values([
    bill(B0400, 'B26-0400', 'Statutory Neglect Amendment Act of 2025'),
    bill(B0001, 'B26-0001', 'Something else'),
    bill(B9999, 'B26-9999', 'Youth rehabilitation study'),
    bill(B0005, 'B25-0005', 'An older bill', LS_EARLIER),
  ])
  await db.insert(schema.billTenants).values([
    { billId: B0400, tenantId: 'oca', matchType: 'keyword' },
    { billId: B0001, tenantId: 'oca', matchType: null },
    { billId: B9999, tenantId: 'oca', matchType: 'manual' },
    { billId: B0005, tenantId: 'oca', matchType: 'keyword' },
  ])
  await db.insert(schema.people).values([
    { peopleId: PARKER, name: 'Zachary Parker', firstName: 'Zachary', lastName: 'Parker', party: 'D', role: 'Rep', roleId: 1, district: 'Ward 5', stateId: 9 },
    { peopleId: BONDS, name: 'Anita Bonds', firstName: 'Anita', lastName: 'Bonds', party: 'D', role: 'Rep', roleId: 1, district: 'At-Large', stateId: 9 },
    { peopleId: GONE, name: 'Jack Evans', firstName: 'Jack', lastName: 'Evans', party: 'D', role: 'Rep', roleId: 1, district: 'Ward 2', stateId: 9 },
  ])
  await db.insert(schema.billSponsors).values([
    { id: 's1', billId: B0400, peopleId: PARKER, sponsorTypeId: 1, sponsorOrder: 1 },
    { id: 's2', billId: B0400, peopleId: BONDS, sponsorTypeId: 2, sponsorOrder: 2 },
  ])
  // What LegiScan's ingests left on B26-0400.
  await db.insert(schema.billTexts).values([
    { docId: 5001, billId: B0400, date: '2025-10-06', type: 'Introduced', mime: 'application/pdf', stateLink: 'https://lims.dccouncil.gov/downloads/LIMS/5001.pdf' },
    { docId: 5009, billId: B9999, date: '2025-10-06', type: 'Introduced', mime: 'application/pdf', stateLink: 'https://lims.dccouncil.gov/downloads/LIMS/5009.pdf' },
  ])
  await db.insert(schema.billSupplements).values({ supplementId: 6001, billId: B0400, type: 'Fiscal Note', title: 'LegiScan fiscal note' })
  await db.insert(schema.billAmendments).values({ amendmentId: 7001, billId: B0400, title: 'LegiScan amendment' })
  await db.insert(schema.rollCalls).values({ rollCallId: 8001, billId: B0400, date: '2026-03-03', description: 'First Reading', yea: 12, nay: 0 })
  await db.insert(schema.rollCallVotes).values({ id: `8001-${PARKER}`, rollCallId: 8001, peopleId: PARKER, voteId: 1, voteText: 'Yea' })
  await db.insert(schema.billCalendar).values([
    // Written before identities were stored: instances know it as '1|committee on youth affairs'.
    { id: 'r1', billId: B0400, typeId: 1, type: 'Hearing', date: '2025-11-13', description: 'Committee on Youth Affairs', eventHash: 'ls-h1', identityKey: null },
    { id: 'r2', billId: B0400, typeId: 3, type: 'Markup Session', date: '2026-01-27', description: 'Committee on Youth Affairs', eventHash: 'ls-m1', identityKey: '3|committee on youth affairs' },
    // A hearing LIMS doesn't list.
    { id: 'r3', billId: B0400, typeId: 1, type: 'Hearing', date: '2026-12-01', description: 'Committee of the Whole', eventHash: 'ls-h2', identityKey: '1|committee of the whole' },
  ])
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-28T09:00:00Z'))   // 5 ET
  await setupLsDb()
  vi.clearAllMocks()
  Object.assign(hooks, { beforeRead: null, beforeLog: null, bill: null, failWrite: false, failVotes: false })
  vi.mocked(getCurrentEtHour).mockReturnValue(5)
  feed = recordedFeed()
  calls = []
  filedLater = []
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push(url)
    if (url.startsWith(LIMS)) return feed[url.slice(LIMS.length)]?.() ?? new Response('not found', { status: 404 })
    if (url.startsWith('https://lims.dccouncil.gov/downloads/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    const u = new URL(url)
    if (u.hostname === 'api.legiscan.com') return Response.json({ status: 'OK', ...(legiscan(u.searchParams.get('op')!, u.searchParams.get('id')) as object) })
    throw new Error(`no network in this test: ${url}`)
  })
  await seedLegiscanDc()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a cutover\'s dry run', () => {
  it('reports what would move, and writes nothing', async () => {
    const run = makeEnv()
    const before = await snapshotTables()
    const res = await cutover(run)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(await snapshotTables()).toEqual(before)
    expect(sentToTenant(run)).toEqual([])
    expect(run.limsQueue.sendBatch).not.toHaveBeenCalled()

    expect(body).toMatchObject({ dryRun: true, state: 'DC', from: 'legiscan', to: 'lims', sessions: ['2025-2026 Council Period 26'] })
    // Bills: matched on session year, kind of session, and number, keeping their handles.
    expect(body.bills.matched).toBe(2)
    expect(body.bills.list).toEqual(expect.arrayContaining([
      { billId: toHandle(B0400), number: 'B26-0400', nativeKey: 'B26-0400', from: '2025-2026 Council Period 26', to: '2025-2026 Council Period 26', tracked: true },
      expect.objectContaining({ billId: toHandle(B0001), number: 'B26-0001', tracked: false }),
    ]))
    // Unmatched on both sides. The earlier session's bill isn't in scope.
    expect(body.bills.unmatched.old).toEqual([{ billId: toHandle(B9999), number: 'B26-9999', session: '2025-2026 Council Period 26', tracked: true, linked: true }])
    expect(body.bills.unmatched.new.map((b: any) => b.number).sort())
      .toEqual(['B26-0769', 'GBM26-0061', 'HN26-0171', 'PR26-0808', 'REPROG26-0153'])

    // Calendar: entries on the same date and of the same kind keep their identities.
    expect(body.calendar.kept.map((k: any) => [k.identityKey, k.kind, k.date])).toEqual(expect.arrayContaining([
      ['1|committee on youth affairs', 'hearing', '2025-11-13'],
      ['3|committee on youth affairs', 'markup', '2026-01-27'],
    ]))
    expect(body.calendar.cancelled).toEqual([expect.objectContaining({ identityKey: '1|committee of the whole', date: '2026-12-01', billId: toHandle(B0400) })])
    expect(body.calendar.added.map((a: any) => [a.kind, a.date])).toEqual(expect.arrayContaining([['markup', '2026-02-23'], ['deadline', '2026-04-28']]))

    // People: LIMS has names and titles, not chambers or wards, so the matches are weak.
    expect(body.people.list).toEqual(expect.arrayContaining([
      { personId: String(PARKER), name: 'Zachary Parker', as: 'Zachary Parker', nameMatch: 'full', on: ['name'], weak: true },
      { personId: String(BONDS), name: 'Anita Bonds', as: 'Anita Bonds', nameMatch: 'full', on: ['name'], weak: true },
    ]))
    expect(body.people.unmatched.old).toEqual([{ personId: String(GONE), name: 'Jack Evans' }])

    // The one thing it writes is the API call log, which counts every call it spent.
    await vi.waitFor(async () => expect((await env.DB.prepare(`SELECT call_type FROM api_call_log`).all()).results.map((r: any) => r.call_type))
      .toEqual(expect.arrayContaining(['lims:BulkData', 'lims:LegislationDetails', 'lims:Members'])))
  })

  it('skips the calendar preview, and its details calls, with calendar=false', async () => {
    const res = await cutover(makeEnv(), '?calendar=false')
    const body = await res.json() as any
    expect(body.calendar).toBeNull()
    expect(body.bills.matched).toBe(2)
    expect(calls.filter(u => u.includes('LegislationDetails'))).toEqual([])
  })

  it('is refused for a provider that doesn\'t serve the state, or the provider the state already has', async () => {
    const run = makeEnv()
    expect((await central('POST', '/admin/state-providers/MD/cutover', run, { provider: 'lims' })).status).toBe(400)
    expect((await central('POST', '/admin/state-providers/DC/cutover', run, { provider: 'legiscan' })).status).toBe(400)
    const noKey = { ...run, env: { ...run.env, LIMS_API_KEY: undefined } }
    expect((await cutover(noKey)).status).toBe(400)
    await env.DB.prepare(`INSERT INTO state_providers (state, provider, previous_provider) VALUES ('DC', 'lims', 'legiscan')`).run()
    expect((await cutover(run)).status).toBe(409)
  })

  it('is refused when nothing would match, since a cutover would only strand LegiScan\'s bills', async () => {
    await env.DB.prepare(`UPDATE bills SET bill_number = 'B26-9' || bill_id WHERE bill_id IN (?, ?)`).bind(B0400, B0001).run()
    const before = await snapshotTables()
    const res = await cutover(makeEnv(), '?confirm=true')
    expect(res.status).toBe(409)
    expect((await res.json() as any).error).toMatch(/would move nothing/)
    expect(await snapshotTables()).toEqual(before)
  })
})

describe('a cutover', () => {
  async function cutOver() {
    const run = makeEnv()
    const res = await cutover(run, '?confirm=true')
    const body = await res.json() as any
    expect(res.status, JSON.stringify(body)).toBe(200)
    return { run, body }
  }

  // #364: the new provider's first pass links its records the old one lacked.
  // They are existing legislation, not newly filed bills, so a match is bulk.
  it('declares the matches of the first pass after it bulk, for bills the old provider lacked', async () => {
    await env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('oca', 'soccer stadium')`).run()

    const { run } = await cutOver()

    const msg = queued(run.limsQueue).find(b => b.billId === limsBillId('B26-0769'))
    expect(msg?.matchProvenance).toEqual({ oca: 'bulk' })
  })

  it('keeps every matched bill\'s handle, flips ownership, and the first LIMS ingest sends no changes', async () => {
    const { run, body } = await cutOver()
    expect(body).toMatchObject({
      ok: true, state: 'DC', from: 'legiscan', to: 'lims',
      bills: { matched: 2, tracked: 1, unmatched: { old: 1, new: 5 } },
      people: { matched: 2, weak: 2 },
    })
    expect((await getJson('/admin/state-providers')).states).toEqual([
      expect.objectContaining({ state: 'DC', provider: 'lims', previousProvider: 'legiscan' }),
    ])

    // LIMS's first pass ran at once: it queued the moved tracked bill under the
    // id instances hold, and gave the monitored one LIMS's status.
    expect(queued(run.limsQueue).map(b => b.billId)).toContain(B0400)
    expect(queued(run.limsQueue).map(b => b.billId)).not.toContain(limsBillId('B26-0400'))
    const stub = sentToTenant(run).find((m: any) => m.billId === toHandle(B0001))
    expect(stub).toMatchObject({ stubOnly: true })

    // Between the cutover and the first ingest, LegiScan's documents and votes are gone.
    const interim = await getJson(`/bills/${toHandle(B0400)}`)
    expect(interim.texts).toEqual([])
    expect(interim.supplements).toEqual([])
    expect(interim.votes).toEqual([])

    await drain(run.limsQueue, run)
    const bill = await getJson(`/bills/${toHandle(B0400)}`)
    expect(bill).toMatchObject({ billId: toHandle(B0400), number: 'B26-0400', status: 'Official Law', statusStage: 'enacted' })
    // The bill moved to LIMS's Council Period, which shares LegiScan's name, so its slug is cp26-2.
    expect(bill).toMatchObject({ sessionId: String(limsSessionId(26)), sessionSlug: 'cp26-2' })
    // LIMS's documents and votes only, never mixed with LegiScan's.
    expect(bill.texts.map((t: any) => t.docId)).not.toContain('5001')
    expect(bill.texts.length).toBeGreaterThan(0)
    expect(bill.supplements.map((s: any) => s.supplementId)).not.toContain(6001)
    expect(bill.votes.map((v: any) => v.id)).not.toContain('8001')
    // Legislators kept their person ids, in sponsors and in votes.
    expect(bill.sponsors.map((s: any) => [s.name, s.personId])).toEqual([['Zachary Parker', String(PARKER)], ['Anita Bonds', String(BONDS)]])
    const firstReading = bill.votes.find((v: any) => v.date === '2026-03-03')
    expect(firstReading.legislatorVotes).toContainEqual({ personId: String(PARKER), name: 'Zachary Parker', vote: 'Yes', url: null })

    // The first ingest is quiet: the instance is told the bill moved, but of no change.
    const notified = sentToTenant(run).filter((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(notified).toHaveLength(1)
    expect(notified[0].changes).toBeUndefined()
    expect(notified[0].calendar.changes).toEqual([])
    expect(bill.updatedAt).not.toBe(interim.updatedAt)

    // Calendar: matched entries keep the identities instances know, with
    // LIMS's details. LegiScan's unmatched hearing is gone, and LIMS's other
    // entries are new.
    const events = notified[0].calendar.events.map((e: any) => [e.identityKey, e.kind, e.date])
    expect(events).toEqual(expect.arrayContaining([
      ['1|committee on youth affairs', 'hearing', '2025-11-13'],
      ['3|committee on youth affairs', 'markup', '2026-01-27'],
      [expect.stringMatching(/^markup\|2026-02-23\|/), 'markup', '2026-02-23'],
      ['id:deadline:mayor-response', 'deadline', '2026-04-28'],
    ]))
    expect(events.map((e: any) => e[0])).not.toContain('1|committee of the whole')
    expect(bill.calendar.map((c: any) => c.date)).not.toContain('2026-12-01')
    expect(bill.calendar.find((c: any) => c.date === '2025-11-13').description).toMatch(/Public Hearing on B26-0400/)

    // The bill LIMS doesn't have stays LegiScan's, as it was.
    const left = await getJson(`/bills/${toHandle(B9999)}`)
    expect(left.texts.map((t: any) => t.docId)).toEqual(['5009'])
    // LegiScan's DC sessions leave the active list: nothing syncs them now.
    expect(await row('SELECT prior, sine_die FROM sessions WHERE session_id = ?', LS_SESSION)).toEqual({ prior: 1, sine_die: 1 })
    // No tenant database was touched: every instance-facing change went out as a notification.
    expect(calls.filter(u => u.includes('api.legiscan.com'))).toEqual([])
  })

  it('reports later changes as usual once the first ingest is done', async () => {
    const { run } = await cutOver()
    await drain(run.limsQueue, run)
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: null })
    // So did the monitored bill.
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0001)).toEqual({ carried_from: null })

    // LIMS records a new action on B26-0400.
    const rec = bulk['B26-0400']
    feed['BulkData/1/26'] = () => json(Object.values(bulk).filter(r => r.legislationCategory === 'Bill' && r.legislationNumber !== 'B26-0400').concat({
      ...rec, legislationHistory: [...(rec.legislationHistory as object[]), { legislationNumber: 'B26-0400', actionDate: 'Sep 01, 2026', actionDescription: 'Committee Mark-up of B26-0400 by the Committee of the Whole', downloadURL: '' }],
    }))
    const next = makeEnv()
    const { runSnapshotSync } = await import('../../src/cron/sync-snapshots')
    const { lims } = await import('../../src/providers/lims')
    await runSnapshotSync(lims, next.env, drizzle(env.DB, { schema }), { force: true })
    await drain(next.limsQueue, next)
    const msg = sentToTenant(next).find((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(msg.changes).toEqual([expect.objectContaining({ changeType: 'action_added', detail: '2026-09-01' })])
  })

  it('waits to carry the calendar over until LIMS sends one', async () => {
    // LIMS answers with no history for B26-0400, which is no calendar at all.
    const rec = bulk['B26-0400']
    const serve = (history: object[]) => {
      feed['BulkData/1/26'] = () => json(Object.values(bulk).filter(r => r.legislationCategory === 'Bill' && r.legislationNumber !== 'B26-0400')
        .concat({ ...rec, legislationHistory: history }))
    }
    serve([])
    const { run } = await cutOver()
    await drain(run.limsQueue, run)
    const quiet = sentToTenant(run).find((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(quiet.changes).toBeUndefined()
    // No calendar block: instances keep the entries they have, and so does central.
    expect(quiet.calendar).toBeUndefined()
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: 'legiscan' })
    expect(await row('SELECT COUNT(*) AS n FROM bill_calendar WHERE bill_id = ? AND cancelled_at IS NULL', B0400)).toEqual({ n: 3 })

    // The next answer has its history back, and the carry-over happens then.
    serve(rec.legislationHistory as object[])
    const next = makeEnv()
    const { runSnapshotSync } = await import('../../src/cron/sync-snapshots')
    const { lims } = await import('../../src/providers/lims')
    await runSnapshotSync(lims, next.env, drizzle(env.DB, { schema }), { force: true })
    await drain(next.limsQueue, next)
    const carried = sentToTenant(next).find((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(carried.changes).toBeUndefined()
    expect(carried.calendar.events.map((e: any) => e.identityKey)).toEqual(expect.arrayContaining(['1|committee on youth affairs', '3|committee on youth affairs']))
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: null })
  })

  it('forgets DC\'s snapshot ETags with the flip, and again with the undo', async () => {
    const etags = async () => (await env.DB.prepare('SELECT session_id, snapshot_etag FROM sessions WHERE snapshot_etag IS NOT NULL').all()).results
    // As if LIMS had owned DC before and stored an ETag for its Council Period.
    await env.DB.prepare(`INSERT INTO sessions (session_id, state, state_id, year_start, year_end, session_title, session_name, session_tag, provider, snapshot_etag)
      VALUES (?, 'DC', 9, 2025, 2026, 'x', '2025-2026 Council Period 26', 'CP26', 'lims', 'stale')`).bind(limsSessionId(26)).run()
    expect((await cutover(makeEnv())).status).toBe(200)
    expect(await etags()).toEqual([{ session_id: limsSessionId(26), snapshot_etag: 'stale' }])

    // LIMS's first sync after the flip fails, so only the cutover's batch can have forgotten the ETag.
    let periods = 0
    feed['CouncilPeriods'] = () => (++periods === 1 ? json([CP26]) : new Response('down', { status: 503 }))
    const run = makeEnv()
    const res = await cutover(run, '?confirm=true')
    expect(res.status).toBe(200)
    expect((await res.json() as any).sync.error).toBeDefined()
    expect((await getJson('/admin/state-providers')).states[0]).toMatchObject({ state: 'DC', provider: 'lims' })
    expect(await etags()).toEqual([])

    // A pass stores one, and the undo forgets it.
    await env.DB.prepare('UPDATE sessions SET snapshot_etag = ? WHERE session_id = ?').bind('lims-2', limsSessionId(26)).run()
    expect((await undo(run, '?confirm=true')).status).toBe(200)
    expect(await etags()).toEqual([])
  })

  it('leaves the state on LegiScan, with nothing written, when it fails partway through', async () => {
    const run = makeEnv()
    // An ETag stays too.
    await env.DB.prepare('UPDATE sessions SET snapshot_etag = ? WHERE session_id = ?').bind('kept', LS_SESSION).run()
    const before = await snapshotTables()
    // The batch's last statement, the ownership flip, fails.
    await env.DB.prepare(`CREATE TRIGGER fail_flip BEFORE INSERT ON state_providers BEGIN SELECT RAISE(ABORT, 'flip failed'); END`).run()
    const res = await cutover(run, '?confirm=true')
    expect(res.status).toBe(502)
    expect((await res.json() as any).error).toMatch(/flip failed/)
    expect(await snapshotTables()).toEqual(before)
    expect(run.limsQueue.sendBatch).not.toHaveBeenCalled()
    expect(sentToTenant(run)).toEqual([])
    await env.DB.prepare('DROP TRIGGER fail_flip').run()

    // DC is still LegiScan's: its sync still runs it.
    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    await runSync(run.env, drizzle(env.DB, { schema }))
    expect(calls.filter(u => u.includes('op=getMasterList'))).toHaveLength(1)
  })

  it('writes nothing when LIMS fails partway through the read', async () => {
    const run = makeEnv()
    const before = await snapshotTables()
    feed['BulkData/14/26'] = () => new Response('upstream error', { status: 500 })
    const res = await cutover(run, '?confirm=true')
    expect(res.status).toBe(502)
    expect(await snapshotTables()).toEqual(before)
  })
})

describe('a cutover beside other work', () => {
  /** A LegiScan ingest of B26-0400, queued before the cutover. */
  async function legiscanIngest(run: Run) {
    const message = { body: { billId: B0400 }, ack: vi.fn(), retry: vi.fn() }
    await processIngestorQueue({ messages: [message] } as any, run.env, drizzle(env.DB, { schema }))
    return message
  }
  const quietFirstIngest = (run: Run) => {
    const sent = sentToTenant(run).filter((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(sent).toHaveLength(1)
    expect(sent[0].changes).toBeUndefined()
    expect(sent[0].calendar.changes).toEqual([])
    const keys = sent[0].calendar.events.map((e: any) => e.identityKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(expect.arrayContaining(['1|committee on youth affairs', '3|committee on youth affairs']))
    return sent[0]
  }

  it('drops a LegiScan ingest that read the bill before the cutover and writes after it', async () => {
    const run = makeEnv()
    hooks.beforeRead = async () => { expect((await cutover(run, '?confirm=true')).status).toBe(200) }
    const stale = makeEnv()
    await legiscanIngest(stale)
    // It wrote nothing: not the bill row, its documents, its change log, or instances.
    expect(await row('SELECT provider, carried_from, change_hash FROM bills WHERE bill_id = ?', B0400))
      .toEqual({ provider: 'lims', carried_from: 'legiscan', change_hash: 'ls-v1' })
    expect(await row('SELECT COUNT(*) AS n FROM bill_texts WHERE bill_id = ?', B0400)).toEqual({ n: 0 })
    expect(await row('SELECT COUNT(*) AS n FROM bill_change_log WHERE bill_id = ?', B0400)).toEqual({ n: 0 })
    expect(sentToTenant(stale)).toEqual([])

    await drain(run.limsQueue, run)
    quietFirstIngest(run)
    expect((await getJson(`/bills/${toHandle(B0400)}`)).texts.map((t: any) => t.docId)).not.toContain('5002')
  })

  it('keeps the first LIMS ingest quiet after a LegiScan ingest that wrote around the cutover', async () => {
    const run = makeEnv()
    // The cutover lands after LegiScan's ingest wrote the bill row and before its documents.
    hooks.beforeLog = async () => { expect((await cutover(run, '?confirm=true')).status).toBe(200) }
    await legiscanIngest(makeEnv())
    expect(await row('SELECT provider, carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ provider: 'lims', carried_from: 'legiscan' })

    await drain(run.limsQueue, run)
    quietFirstIngest(run)
    expect((await getJson(`/bills/${toHandle(B0400)}`)).texts.map((t: any) => t.docId)).not.toContain('5002')
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: null })
  })

  it('retries a first LIMS ingest that failed partway just as quietly', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    const body = queued(run.limsQueue).find(b => b.billId === B0400)
    hooks.failWrite = true
    const first = { body, ack: vi.fn(), retry: vi.fn() }
    await processIngestorQueue({ messages: [first] } as any, run.env, drizzle(env.DB, { schema }))
    expect(first.retry).toHaveBeenCalled()
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: 'legiscan' })

    // The next try fails later, after the calendar carried over, so the one
    // after carries over a calendar that already has LIMS's details.
    hooks.failVotes = true
    const second = { body, ack: vi.fn(), retry: vi.fn() }
    await processIngestorQueue({ messages: [second] } as any, run.env, drizzle(env.DB, { schema }))
    expect(second.retry).toHaveBeenCalled()
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: 'legiscan' })
    expect(await row(`SELECT COUNT(*) AS n FROM bill_calendar WHERE bill_id = ? AND identity_key = '1|committee on youth affairs' AND description LIKE 'Public Hearing%'`, B0400)).toEqual({ n: 1 })

    const again = { body, ack: vi.fn(), retry: vi.fn() }
    await processIngestorQueue({ messages: [again] } as any, run.env, drizzle(env.DB, { schema }))
    expect(again.ack).toHaveBeenCalled()
    quietFirstIngest(run)
    expect(await row('SELECT COUNT(*) AS n FROM bill_change_log WHERE bill_id = ?', B0400)).toEqual({ n: 0 })
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: null })
  })

  it('leaves an undo that lands during the first LIMS ingest to LegiScan\'s quiet ingest', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    // The undo lands after LIMS's ingest wrote the bill row, and LIMS goes on writing its documents.
    hooks.bill = B0400
    hooks.beforeLog = async () => { expect((await undo(run, '?confirm=true')).status).toBe(200) }
    await drain(run.limsQueue, run)
    // The bill is LegiScan's again, and holds LIMS's data, so it's carried from LIMS.
    expect(await row('SELECT provider, carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ provider: 'legiscan', carried_from: 'lims' })

    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    const again = makeEnv()
    await runSync(again.env, drizzle(env.DB, { schema }))
    await drain(again.ingestor, again)
    const bill = await getJson(`/bills/${toHandle(B0400)}`)
    // Only LegiScan's documents and votes, with nothing of LIMS's left behind.
    expect(bill.texts.map((t: any) => t.docId)).toEqual(['5002'])
    expect(bill.votes).toEqual([])
    const msg = sentToTenant(again).find((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(msg.changes).toBeUndefined()
    expect(msg.calendar.changes).toEqual([])
    expect(await row('SELECT COUNT(*) AS n FROM bill_change_log WHERE bill_id = ?', B0400)).toEqual({ n: 0 })
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: null })
  })

  it('has LegiScan ingest a tracked bill an undo moved back before LIMS ingested it', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    // LIMS never gets to B26-0400, so its change hash is still the one LegiScan last ingested.
    expect((await undo(run, '?confirm=true')).status).toBe(200)
    expect(await row('SELECT provider, carried_from, change_hash FROM bills WHERE bill_id = ?', B0400))
      .toEqual({ provider: 'legiscan', carried_from: 'legiscan', change_hash: 'ls-v1' })
    // And LegiScan's copy hasn't changed since.
    await env.DB.prepare(`UPDATE bills SET change_hash = 'ls-v2' WHERE bill_id = ?`).bind(B0400).run()

    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    const again = makeEnv()
    await runSync(again.env, drizzle(env.DB, { schema }))
    expect(queued(again.ingestor).map(b => b.billId)).toContain(B0400)
    await drain(again.ingestor, again)
    expect((await getJson(`/bills/${toHandle(B0400)}`)).texts.map((t: any) => t.docId)).toEqual(['5002'])
    const msg = sentToTenant(again).find((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(msg.changes).toBeUndefined()
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: null })

    // Once ingested, an unchanged bill isn't queued again.
    const later = makeEnv()
    const before = calls.length
    await runSync(later.env, drizzle(env.DB, { schema }))
    expect(calls.slice(before).some(u => u.includes('op=getMasterList'))).toBe(true)
    expect(queued(later.ingestor).map(b => b.billId)).not.toContain(B0400)
  })

  it('keeps sponsors and votes when LIMS\'s first sync fails and the next hourly pass ingests', async () => {
    let periods = 0
    feed['CouncilPeriods'] = () => (++periods === 2 ? new Response('down', { status: 503 }) : json([CP26]))
    const res = await cutover(makeEnv(), '?confirm=true')
    expect((await res.json() as any).sync.error).toBeDefined()
    // The matched legislators are LIMS's already, without its session refresh.
    expect(await row('SELECT provider FROM people WHERE people_id = ?', PARKER)).toEqual({ provider: 'lims' })

    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    const next = makeEnv()
    const { runSnapshotSync } = await import('../../src/cron/sync-snapshots')
    const { lims } = await import('../../src/providers/lims')
    await runSnapshotSync(lims, next.env, drizzle(env.DB, { schema }))
    await drain(next.limsQueue, next)
    const bill = await getJson(`/bills/${toHandle(B0400)}`)
    expect(bill.sponsors.map((s: any) => s.personId)).toEqual([String(PARKER), String(BONDS)])
    expect(bill.votes.find((v: any) => v.date === '2026-03-03').legislatorVotes)
      .toContainEqual({ personId: String(PARKER), name: 'Zachary Parker', vote: 'Yes', url: null })
  })

  it('ingests a tracked bill whose keyword match the new title loses, so its documents are replaced', async () => {
    // B26-0001 is tracked through a keyword only LegiScan's title has.
    await env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('oca', 'legiscan-only-term')`).run()
    await env.DB.prepare(`UPDATE bills SET title = 'Legiscan-only-term act' WHERE bill_id = ?`).bind(B0001).run()
    await env.DB.prepare(`UPDATE bill_tenants SET match_type = 'keyword' WHERE bill_id = ?`).bind(B0001).run()
    await env.DB.prepare(`INSERT INTO bill_texts (doc_id, bill_id, date, type, mime, state_link) VALUES (5011, ?, '2025-01-01', 'Introduced', 'application/pdf', 'x')`).bind(B0001).run()
    feed['LegislationDetails/B26-0001'] = () => json({
      ...JSON.parse(details0400Raw), legislationNumber: 'B26-0001', status: 'Under Council Review',
      committeeHearing: [], committeeMarkup: [], actions: [], otherDocuments: [], mayoralReview: null, congressionalReview: null,
    })

    // The dry run says so.
    const dry = await (await cutover(makeEnv())).json() as any
    expect(dry.bills.losingMatch).toEqual([{ billId: toHandle(B0001), number: 'B26-0001', tenantId: 'oca' }])

    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    expect(queued(run.limsQueue).map(b => b.billId)).toContain(B0001)
    await drain(run.limsQueue, run)
    expect(await row('SELECT match_type FROM bill_tenants WHERE bill_id = ?', B0001)).toEqual({ match_type: null })
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0001)).toEqual({ carried_from: null })
    const bill = await getJson(`/bills/${toHandle(B0001)}`)
    expect(bill.texts.map((t: any) => t.docId)).not.toContain('5011')
    expect(bill.actions.length).toBeGreaterThan(0)
  })

  it('keeps giving a legislator their kept id once LIMS lists them under a new one', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    await drain(run.limsQueue, run)
    // A new Council Period's member id for the same person.
    await env.DB.prepare(`INSERT INTO people (people_id, name, provider) VALUES (?, 'Zachary Parker', 'lims')`).bind(1_000_000_900).run()
    const again = makeEnv()
    await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack: vi.fn(), retry: vi.fn() }] } as any, again.env, drizzle(env.DB, { schema }))
    expect((await getJson(`/bills/${toHandle(B0400)}`)).sponsors.map((s: any) => s.personId)).toEqual([String(PARKER), String(BONDS)])
  })

  it('stops waiting for a calendar after three ingests without one, and cancels the old entries', async () => {
    const rec = bulk['B26-0400']
    feed['BulkData/1/26'] = () => json(Object.values(bulk).filter(r => r.legislationCategory === 'Bill' && r.legislationNumber !== 'B26-0400')
      .concat({ ...rec, legislationHistory: [] }))
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    await drain(run.limsQueue, run)
    const ingest = async () => {
      const r = makeEnv()
      await processIngestorQueue({ messages: [{ body: { billId: B0400 }, ack: vi.fn(), retry: vi.fn() }] } as any, r.env, drizzle(env.DB, { schema }))
      return sentToTenant(r).find((m: any) => m.billId === toHandle(B0400))
    }
    expect((await ingest()).calendar).toBeUndefined()
    expect(await row('SELECT carried_from, carried_waits FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: 'legiscan', carried_waits: 2 })
    const third = await ingest()
    expect(third.changes).toBeUndefined()
    expect(await row('SELECT carried_from, carried_waits FROM bills WHERE bill_id = ?', B0400)).toEqual({ carried_from: null, carried_waits: null })
    expect(await row('SELECT COUNT(*) AS n FROM bill_calendar WHERE bill_id = ? AND cancelled_at IS NULL', B0400)).toEqual({ n: 0 })
  })
})

describe('a moved bill no instance tracks', () => {
  beforeEach(async () => {
    // What LegiScan's bulk seed left on the monitored B26-0001.
    await env.DB.prepare(`INSERT INTO bill_texts (doc_id, bill_id, date, type, mime, state_link) VALUES (5003, ?, '2025-01-06', 'Introduced', 'application/pdf', 'https://lims.dccouncil.gov/downloads/LIMS/5003.pdf')`).bind(B0001).run()
    await env.DB.prepare(`INSERT INTO roll_calls (roll_call_id, bill_id, date, description, yea, nay) VALUES (8003, ?, '2025-01-07', 'Final Reading', 13, 0)`).bind(B0001).run()
  })

  const legiscanCalls = (op: string) => calls.filter(u => u.includes('api.legiscan.com') && u.includes(`op=${op}`))

  it('gets a quiet first LIMS ingest too, which replaces its documents and votes and leaves it a monitored bill', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    // Queued on LIMS's own queue, for its first ingest, though nothing tracks
    // it, and after the tracked bill, so that one doesn't wait behind it.
    const order = queued(run.limsQueue)
    expect(order).toContainEqual({ billId: B0001, firstIngestFor: 'lims' })
    expect(order.findIndex(b => b.billId === B0400)).toBeLessThan(order.findIndex(b => b.billId === B0001))
    expect(run.ingestor.sendBatch).not.toHaveBeenCalled()
    const before = await getJson(`/bills/${toHandle(B0001)}`)
    expect(before.texts).toEqual([])
    expect(before.votes).toEqual([])

    await drain(run.limsQueue, run)
    const bill = await getJson(`/bills/${toHandle(B0001)}`)
    expect(bill).toMatchObject({ number: 'B26-0001', status: 'Enacted', sessionSlug: 'cp26-2' })
    // LIMS's documents and votes, with none of LegiScan's left.
    expect(bill.texts.length).toBeGreaterThan(0)
    expect(bill.texts.map((t: any) => t.docId)).not.toContain('5003')
    expect(bill.votes.map((v: any) => v.id)).not.toContain('8003')
    expect(bill.votes.find((v: any) => v.date === '2026-03-03').legislatorVotes)
      .toContainEqual({ personId: String(PARKER), name: 'Zachary Parker', vote: 'Yes', url: null })
    expect(bill.actions.map((a: any) => a.description)).toContain('Retained by the Council')
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0001)).toEqual({ carried_from: null })

    // Instances are told of no change, and nothing became tracked.
    const sent = sentToTenant(run).filter((m: any) => m.billId === toHandle(B0001))
    expect(sent.length).toBeGreaterThan(0)
    for (const m of sent) {
      expect(m.changes).toBeUndefined()
      expect(m.calendar?.changes ?? []).toEqual([])
      expect(m.forceAI).toBeFalsy()
      expect(m.matchType ?? null).toBeNull()
    }
    expect(await row('SELECT match_type FROM bill_tenants WHERE bill_id = ?', B0001)).toEqual({ match_type: null })
    expect(await row('SELECT COUNT(*) AS n FROM bill_change_log WHERE bill_id = ?', B0001)).toEqual({ n: 0 })

    // Ingested once, it isn't queued again until LIMS changes it.
    const next = makeEnv()
    const { runSnapshotSync } = await import('../../src/cron/sync-snapshots')
    const { lims } = await import('../../src/providers/lims')
    await runSnapshotSync(lims, next.env, drizzle(env.DB, { schema }), { force: true })
    expect(queued(next.limsQueue).map(b => b.billId)).not.toContain(B0001)
  })

  it('reaches the instance as one stub from LIMS\'s first pass, which already shows LIMS\'s status', async () => {
    const run = makeEnv()
    // What the instance reads for each stub, at the moment it is sent.
    const readAtSend: string[] = []
    run.tenantQueue.sendBatch.mockImplementation(async (msgs: { body: any }[]) => {
      for (const { body } of msgs) {
        if (body.stubOnly && body.billId === toHandle(B0001)) readAtSend.push((await getJson(`/bills/${toHandle(B0001)}`)).status)
      }
    })
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    expect(readAtSend).toEqual(['Enacted'])
    expect(sentToTenant(run).filter((m: any) => m.stubOnly).map((m: any) => m.billId)).not.toContain(toHandle(B0400))
  })

  it('is queued again by a forced sync while its first ingest waits, at no second LIMS call', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    const { runSnapshotSync } = await import('../../src/cron/sync-snapshots')
    const { lims } = await import('../../src/providers/lims')
    await runSnapshotSync(lims, run.env, drizzle(env.DB, { schema }), { force: true })
    expect(queued(run.limsQueue).filter(b => b.billId === B0001)).toHaveLength(2)

    await drain(run.limsQueue, run)
    expect(calls.filter(u => u.endsWith('LegislationDetails/B26-0001'))).toHaveLength(1)
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0001)).toEqual({ carried_from: null })
  })

  it('is still ingested for a new keyword match queued before its first ingest ran', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    const first = queued(run.limsQueue).find(b => b.billId === B0001)
    // While the queue drains, the instance adds a keyword the bill matches,
    // and the next pass queues it as tracked.
    await env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('oca', 'rent stabilized')`).run()
    const next = makeEnv()
    const { runSnapshotSync } = await import('../../src/cron/sync-snapshots')
    const { lims } = await import('../../src/providers/lims')
    await runSnapshotSync(lims, next.env, drizzle(env.DB, { schema }), { force: true })
    const matched = queued(next.limsQueue).find(b => b.billId === B0001)
    // A monitored bill that starts to match is a bulk match (#364).
    expect(matched).toEqual({ billId: B0001, queuedBy: 'lims', matchProvenance: { oca: 'bulk' } })

    // The earlier first ingest runs, and clears carried_from.
    const ingest = async (body: unknown, r: Run) => {
      const m = { body, ack: vi.fn(), retry: vi.fn() }
      await processIngestorQueue({ messages: [m] } as any, r.env, drizzle(env.DB, { schema }))
      expect(m.ack).toHaveBeenCalled()
    }
    await ingest(first, run)
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0001)).toEqual({ carried_from: null })

    // The match's message still runs, so the instance hears of the match.
    const after = makeEnv()
    await ingest(matched, after)
    expect(calls.filter(u => u.endsWith('LegislationDetails/B26-0001'))).toHaveLength(2)
    expect(sentToTenant(after)).toContainEqual(expect.objectContaining({ billId: toHandle(B0001), matchType: 'keyword' }))
  })

  it('isn\'t queued by LegiScan after an undo, so it costs no getBill', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    // The undo lands while LIMS's first ingests still wait in its queue.
    expect((await undo(run, '?confirm=true')).status).toBe(200)
    // Both waiting messages are skipped, the tracked bill's too: LIMS's
    // consumer spends no LegiScan call.
    const waiting = await drain(run.limsQueue, run)
    for (const m of waiting.filter(m => m.body.billId === B0001 || m.body.billId === B0400)) expect(m.ack).toHaveBeenCalled()
    expect(calls.filter(u => u.includes('LegislationDetails/B26-0'))).toEqual([])
    expect(legiscanCalls('getBill')).toEqual([])

    // LegiScan's next full pass queues only the tracked bill, on its own
    // queue, and gives the monitored one LegiScan's status, with a stub.
    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    const again = makeEnv()
    await runSync(again.env, drizzle(env.DB, { schema }))
    expect(queued(again.ingestor).map(b => b.billId)).toContain(B0400)
    expect(queued(again.ingestor).map(b => b.billId)).not.toContain(B0001)
    await drain(again.ingestor, again)
    expect(legiscanCalls('getBill').filter(u => !u.includes(`id=${B0400}`))).toEqual([])
    expect(sentToTenant(again)).toContainEqual(expect.objectContaining({ billId: toHandle(B0001), stubOnly: true }))
    expect(await getJson(`/bills/${toHandle(B0001)}`)).toMatchObject({ status: 'Introduced' })
  })

  // #364: the untracked moved bill keeps carried_from for good, since LegiScan
  // never ingests it. That must not make the session's new matches bulk.
  it('leaves a bill filed after the undo a routine match', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    expect((await undo(run, '?confirm=true')).status).toBe(200)
    await drain(run.limsQueue, run)
    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    const first = makeEnv()
    await runSync(first.env, drizzle(env.DB, { schema }))
    await drain(first.ingestor, first)
    expect((await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0001)).carried_from).not.toBeNull()

    const FILED = 1900777
    filedLater = [{ billId: FILED, number: 'B26-0777', title: 'Child Neglect Prevention Act of 2026' }]
    const next = makeEnv()
    await runSync(next.env, drizzle(env.DB, { schema }))

    expect(queued(next.ingestor).find(b => b.billId === FILED)?.matchProvenance).toEqual({ oca: 'routine' })
  })

  // A pass that ingests a moved bill for the first time, because the bill
  // starts to match in that very pass, is still a cutover's pass.
  it('declares bulk in the pass where an untracked moved bill starts to match', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    expect((await undo(run, '?confirm=true')).status).toBe(200)
    await drain(run.limsQueue, run)
    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    const first = makeEnv()
    await runSync(first.env, drizzle(env.DB, { schema }))
    await drain(first.ingestor, first)

    await env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('oca', 'something else')`).run()
    const FILED = 1900778
    filedLater = [{ billId: FILED, number: 'B26-0778', title: 'Child Neglect Prevention Act of 2026' }]
    const next = makeEnv()
    await runSync(next.env, drizzle(env.DB, { schema }))

    expect(queued(next.ingestor).map(b => b.billId)).toContain(B0001)
    expect(queued(next.ingestor).find(b => b.billId === FILED)?.matchProvenance).toEqual({ oca: 'bulk' })
  })
})

describe('undoing a cutover', () => {
  it('flips DC back, and LegiScan\'s next sync rewrites the moved bills with a quiet first ingest', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    await drain(run.limsQueue, run)

    // A dry run first: what would go back.
    const dry = await undo(run)
    expect(dry.status).toBe(200)
    // LIMS added five bills in the meantime, two of them tracked through the instance's keywords.
    expect(await dry.json()).toMatchObject({ dryRun: true, state: 'DC', from: 'lims', to: 'legiscan', bills: 2, people: 2, added: 5, addedTracked: 2 })
    expect((await getJson('/admin/state-providers')).states[0]).toMatchObject({ provider: 'lims' })

    const res = await undo(run, '?confirm=true')
    expect(res.status).toBe(200)
    expect((await getJson('/admin/state-providers')).states).toEqual([
      expect.objectContaining({ state: 'DC', provider: 'legiscan', previousProvider: 'lims' }),
    ])
    // Back in LegiScan's session, under the same handle, with LIMS's documents cleared.
    const back = await getJson(`/bills/${toHandle(B0400)}`)
    expect(back).toMatchObject({ billId: toHandle(B0400), sessionId: String(LS_SESSION), sessionSlug: 'cp26' })
    expect(back.texts).toEqual([])
    expect(await row('SELECT prior, sine_die FROM sessions WHERE session_id = ?', LS_SESSION)).toEqual({ prior: 0, sine_die: 0 })
    expect(await row('SELECT prior, sine_die FROM sessions WHERE session_id = ?', limsSessionId(26))).toEqual({ prior: 1, sine_die: 1 })

    // LegiScan's sync picks DC up again and rewrites the bill.
    vi.mocked(getCurrentEtHour).mockReturnValue(13)
    const again = makeEnv()
    await runSync(again.env, drizzle(env.DB, { schema }))
    expect(queued(again.ingestor).map(b => b.billId)).toContain(B0400)
    await drain(again.ingestor, again)

    const rewritten = await getJson(`/bills/${toHandle(B0400)}`)
    expect(rewritten.texts.map((t: any) => t.docId)).toEqual(['5002'])
    expect(rewritten.sponsors.map((s: any) => s.personId)).toEqual([String(PARKER)])
    const msg = sentToTenant(again).find((m: any) => m.billId === toHandle(B0400) && !m.stubOnly)
    expect(msg.changes).toBeUndefined()
    expect(msg.calendar.changes).toEqual([])
    // The entries instances had through both moves keep their identities.
    expect(msg.calendar.events.map((e: any) => [e.identityKey, e.date])).toEqual([
      ['1|committee on youth affairs', '2025-11-13'],
      ['3|committee on youth affairs', '2026-01-27'],
    ])
  })

  it('has nothing to undo for a state no cutover moved', async () => {
    expect((await undo(makeEnv(), '?confirm=true')).status).toBe(404)
  })
})

describe('seeding a session for an instance', () => {
  it('is refused for a session whose provider no longer owns its state', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    const res = await central('POST', `/tenants/seed-session/oca?sessionId=${LS_EARLIER}&skipQueue=true`, run)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ owner: 'lims' })
    const ok = await central('POST', `/tenants/seed-session/oca?sessionId=${limsSessionId(26)}&skipQueue=true`, run)
    expect(ok.status).toBe(200)
  })
})
