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

function recordedFeed(): Record<string, () => Response> {
  const routes: Record<string, () => Response> = {
    'CouncilPeriods': () => json([CP26]),
    'Members/26': () => json(JSON.parse(membersRaw)),
    'LegislationDetails/B26-0400': () => json(JSON.parse(details0400Raw)),
    'LegislationDetails/HN26-0171': () => json(JSON.parse(detailsHnRaw)),
    'LegislationDetails/REPROG26-0153': () => json(JSON.parse(detailsReprogRaw)),
  }
  for (const [name, id] of Object.entries(CATEGORY_IDS)) {
    routes[`BulkData/${id}/26`] = () => json(Object.values(bulk).filter(r => r.legislationCategory === name))
  }
  return routes
}

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
  vi.mocked(getCurrentEtHour).mockReturnValue(5)
  feed = recordedFeed()
  calls = []
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
})

describe('a cutover', () => {
  async function cutOver() {
    const run = makeEnv()
    const res = await cutover(run, '?confirm=true')
    const body = await res.json() as any
    expect(res.status, JSON.stringify(body)).toBe(200)
    return { run, body }
  }

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
    expect(firstReading.legislatorVotes).toContainEqual({ personId: String(PARKER), name: 'Zachary Parker', vote: 'Yes' })

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
      ['deadline|2026-04-28|mayor\'s response due', 'deadline', '2026-04-28'],
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
    // The monitored bill hasn't been ingested yet, so its first ingest is still to come.
    expect(await row('SELECT carried_from FROM bills WHERE bill_id = ?', B0001)).toEqual({ carried_from: 'legiscan' })

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

  it('leaves the state on LegiScan, with nothing written, when it fails partway through', async () => {
    const run = makeEnv()
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

describe('undoing a cutover', () => {
  it('flips DC back, and LegiScan\'s next sync rewrites the moved bills with a quiet first ingest', async () => {
    const run = makeEnv()
    expect((await cutover(run, '?confirm=true')).status).toBe(200)
    await drain(run.limsQueue, run)

    // A dry run first: what would go back.
    const dry = await undo(run)
    expect(dry.status).toBe(200)
    expect(await dry.json()).toMatchObject({ dryRun: true, state: 'DC', from: 'lims', to: 'legiscan', bills: 2, people: 2, added: 5 })
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
