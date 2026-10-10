import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/db/schema'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'
import exampleSessionRaw from '../fixtures/example/session-2026.json?raw'

// Bill calendar entries at the main seam (#295): through LegiScan, its API
// stubbed at fetch, and through the test-only example provider, whose feed
// carries its own event ids. The hourly sync and the ingest run for real, and
// the checks are only on central's bill API and the notifications queued for
// the instance. test/cron/lims-provider.test.ts covers DC's entries from LIMS.

vi.mock('../../src/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers')>()
  const { example } = await import('../providers/example')
  const PROVIDERS = [...actual.PROVIDERS, example]
  const findProvider = (id: string | null | undefined) => PROVIDERS.find(p => p.id === id)
  return {
    ...actual,
    PROVIDERS,
    findProvider,
    getProvider: (id: string) => {
      const p = findProvider(id)
      if (!p) throw new Error(`unknown provider: ${id}`)
      return p
    },
  }
})

vi.mock('../../src/lib/rateLimitedFetch', () => ({
  // Unpaced, so each LegiScan call doesn't cost the test a second. Each attempt is still logged.
  rateLimitedFetch: async (url: string, init: RequestInit | undefined, opts: { onRequest?: () => void }) => {
    const res = await fetch(url, init)
    opts.onRequest?.()
    return res
  },
}))
vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 13) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { runSync } from '../../src/cron/sync'
import { runSnapshotSync } from '../../src/cron/sync-snapshots'
import { example, exampleFeed, type ExampleRecord } from '../providers/example'
import { getCurrentEtHour } from '../../src/lib/sync-schedule'
import { processIngestorQueue } from '../../src/queue/processor'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

const SESSION = 2154
const BILL = 9001

type Entry = { type_id: number; type: string; date: string; time: string; location: string; description: string; event_hash: string }
const HEARING: Entry = { type_id: 1, type: 'Hearing', date: '2026-10-20', time: '14:00', location: 'Room 35', description: 'House Cmte on Elections', event_hash: 'e-hearing' }
const MARKUP: Entry = { type_id: 3, type: 'Markup Session', date: '2026-10-27', time: '10:00', location: 'Room 35', description: 'House Cmte on Elections', event_hash: 'e-markup' }

/** What LegiScan serves for the bill: its change hash and calendar. Tests move it on. */
let served: { hash: string; calendar: Entry[] }

function getBill() {
  return {
    bill_id: BILL, change_hash: served.hash, session_id: SESSION, state: 'RI', state_id: 39, bill_number: 'H1',
    bill_type: 'B', bill_type_id: '1', body: 'H', body_id: 1, current_body: 'H', current_body_id: 1,
    title: 'Voter access act', description: 'Voter access act', status: 1, status_date: '2026-09-01', pending_committee_id: 0,
    url: 'https://legiscan.com/RI/bill/H1/2026', state_link: 'https://webserver.rilegislature.gov/H1',
    session: { session_id: SESSION, session_name: '2026 Regular Session', year_start: 2026, year_end: 2026 },
    committee: [], referrals: [], progress: [], sponsors: [], sasts: [], subjects: [], votes: [], texts: [], amendments: [], supplements: [],
    history: [{ date: '2026-09-01', action: 'Introduced', chamber: 'H', chamber_id: 1, importance: 1 }],
    calendar: served.calendar,
  }
}

function legiscanResponse(op: string, id: string | null): unknown {
  if (op === 'getBill' && id === String(BILL)) return { bill: getBill() }
  if (op === 'getMasterList' && id === String(SESSION)) {
    return { masterlist: {
      session: { session_id: SESSION, session_name: '2026 Regular Session' },
      0: { bill_id: BILL, number: 'H1', change_hash: served.hash, title: 'Voter access act', description: 'Voter access act',
        status: 1, status_date: '2026-09-01', last_action: 'Introduced', last_action_date: '2026-09-01', url: 'https://legiscan.com/RI/bill/H1/2026' },
    } }
  }
  if (op === 'getMasterListRaw' && id === String(SESSION)) {
    return { masterlist: { 0: { bill_id: BILL, number: 'H1', change_hash: served.hash, title: 'Voter access act', description: '' } } }
  }
  throw new Error(`unexpected LegiScan call ${op} ${id}`)
}

const legiscanCalls = () => fetchMock.mock.calls
  .map(c => new URL(String(c[0])))
  .filter(u => u.hostname === 'api.legiscan.com')
  .map(u => `${u.searchParams.get('op')}:${u.searchParams.get('id')}`)

const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
const e = () => ({ ...(env as any), [tenantQueueBindingName('team')]: tenantQueue, ADMIN_SECRET: 'test-secret' })

/**
 * One sync tick at an ET hour (13 is a full pass, 15 and 17 raw passes), then
 * every message it queued for the ingestor. Returns what the instance was sent.
 */
async function tick(hour: number) {
  const db = drizzle(env.DB, { schema })
  const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  const run = { ...e(), INGESTOR_QUEUE: ingestor }
  vi.mocked(getCurrentEtHour).mockReturnValue(hour)
  const sentBefore = tenantQueue.send.mock.calls.length
  await runSync(run, db)
  const queued = ingestor.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))
  for (const body of queued) {
    const retry = vi.fn()
    await processIngestorQueue({ messages: [{ body, ack: vi.fn(), retry }] } as any, run, db)
    expect(retry).not.toHaveBeenCalled()
  }
  return { queued, sent: tenantQueue.send.mock.calls.slice(sentBefore).map(c => c[0]) }
}

async function billCalendar() {
  const { app } = await import('../../src/index-legiscan')
  const res = await app.fetch(new Request(`http://central/api/bills/legiscan:${BILL}`, { headers: { 'x-admin-secret': 'test-secret' } }), e())
  expect(res.status).toBe(200)
  return ((await res.json()) as any).calendar.map((c: any) => [c.kind, c.date, c.description])
}

const events = (msg: any) => msg.calendar.events.map((ev: any) => [ev.identityKey, ev.kind, ev.date])
const changes = (msg: any) => (msg.calendar?.changes ?? []).map((ch: any) => [ch.changeType, ch.identityKey])

async function seed() {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name)
      VALUES (${SESSION}, 39, 'RI', 2026, 2026, '', '2026 Regular Session', '2026 Regular Session')`),
    env.DB.prepare(`INSERT INTO tenants (tenant_id, name, state_coverage, active) VALUES ('team', 'Team', '["RI"]', 1)`),
    env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('team', 'voter')`),
  ])
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-05T17:00:00Z'))
  served = { hash: 'v1', calendar: [HEARING, MARKUP] }
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const body = legiscanResponse(url.searchParams.get('op')!, url.searchParams.get('id'))
    return Response.json({ status: 'OK', ...(body as object) })
  })
})

describe('LegiScan calendar entries', () => {
  beforeEach(async () => {
    await setupDb(legiscanMigrations)
    await seed()
    await tick(13)
  })

  it('keep their identity byte for byte, and go out with a kind central set', async () => {
    const { sent } = await tick(13)   // nothing changed: nothing queued
    expect(sent).toEqual([])
    const first = tenantQueue.send.mock.calls.map(c => c[0]).find((m: any) => m.calendar)
    // The tenant's UID is hearing-legiscan-9001-1-house-cmte-on-elections@team, as it always was.
    expect(events(first)).toEqual([
      ['1|house cmte on elections', 'hearing', '2026-10-20'],
      ['3|house cmte on elections', 'markup', '2026-10-27'],
    ])
    expect(await billCalendar()).toEqual([
      ['hearing', '2026-10-20', 'House Cmte on Elections'],
      ['markup', '2026-10-27', 'House Cmte on Elections'],
    ])
  })

  it('keep both of two hearings before one committee on the bill, under the one identity instances know', async () => {
    const again = { ...HEARING, date: '2026-11-03', event_hash: 'e-hearing-2' }
    served = { hash: 'v2', calendar: [HEARING, MARKUP, again] }
    const { sent } = await tick(15)
    expect(await billCalendar()).toEqual([
      ['hearing', '2026-10-20', 'House Cmte on Elections'],
      ['markup', '2026-10-27', 'House Cmte on Elections'],
      ['hearing', '2026-11-03', 'House Cmte on Elections'],
    ])
    // One calendar UID for the two, as before: the later hearing.
    expect(events(sent[0])).toEqual([
      ['3|house cmte on elections', 'markup', '2026-10-27'],
      ['1|house cmte on elections', 'hearing', '2026-11-03'],
    ])
  })

  it('count an ingest of a record already pulled as the same pull', async () => {
    served = { hash: 'v2', calendar: [HEARING] }
    await tick(15)
    // An operator re-ingests the bill at the same hash: still one pull, so nothing is cancelled.
    const db = drizzle(env.DB, { schema })
    await processIngestorQueue({ messages: [{ body: { billId: BILL }, ack: vi.fn(), retry: vi.fn() }] } as any, e(), db)
    expect(await billCalendar()).toHaveLength(2)
  })

  it('read a moved hearing as changed, under the same identity', async () => {
    served = { hash: 'v2', calendar: [{ ...HEARING, date: '2026-10-21', event_hash: 'e-hearing-2' }, MARKUP] }
    const { sent } = await tick(15)
    expect(changes(sent[0])).toEqual([['hearing_changed', '1|house cmte on elections']])
  })

  it('keep an entry LegiScan drops until a second pull confirms it, then cancel it, with no extra LegiScan call', async () => {
    served = { hash: 'v2', calendar: [HEARING] }
    const missedOnce = await tick(15)
    expect(missedOnce.queued).toEqual([{ billId: BILL }])
    // One pull: still on the calendar, and nobody is told it was cancelled.
    expect(changes(missedOnce.sent[0])).toEqual([])
    expect(events(missedOnce.sent[0]).map((ev: any) => ev[0])).toEqual(['1|house cmte on elections', '3|house cmte on elections'])
    expect(await billCalendar()).toHaveLength(2)

    // The next raw pass lists the bill unchanged: LegiScan still serves the
    // record the markup was missing from, which is the second pull.
    const callsBefore = legiscanCalls().length
    const confirmed = await tick(17)
    expect(confirmed.queued).toEqual([{ billId: BILL, calendarRecheck: 'v2' }])
    expect(legiscanCalls().slice(callsBefore)).toEqual([`getMasterListRaw:${SESSION}`])
    expect(changes(confirmed.sent[0])).toEqual([['hearing_cancelled', '3|house cmte on elections']])
    expect(events(confirmed.sent[0]).map((ev: any) => ev[0])).toEqual(['1|house cmte on elections'])
    expect(await billCalendar()).toEqual([['hearing', '2026-10-20', 'House Cmte on Elections']])

    // Cancelled, not deleted.
    const rows = await drizzle(env.DB, { schema }).select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, BILL)).all()
    expect(rows.map(r => [r.typeId, r.cancelledAt !== null]).sort()).toEqual([[1, false], [3, true]])

    // The change log records it, as before.
    const log = await drizzle(env.DB, { schema }).select().from(schema.billChangeLog).where(eq(schema.billChangeLog.billId, BILL)).all()
    expect(log.filter(l => l.changeType === 'hearing_cancelled').map(l => [l.newValue, l.detail])).toEqual([['House Cmte on Elections', '2026-10-27']])

    // And it comes back under the same identity if LegiScan lists it again.
    served = { hash: 'v3', calendar: [HEARING, MARKUP] }
    const back = await tick(15)
    expect(changes(back.sent[0])).toEqual([['hearing_added', '3|house cmte on elections']])
  })

  it('never cancel anything on an empty calendar, however often it comes', async () => {
    for (const [hash, hour] of [['v2', 15], ['v2', 17], ['v3', 15], ['v3', 17]] as const) {
      served = { hash, calendar: [] }
      const { sent } = await tick(hour)
      for (const msg of sent) expect(changes(msg)).toEqual([])
    }
    expect(await billCalendar()).toHaveLength(2)
  })

  it('keep a past entry on the calendar, live, for as long as LegiScan lists it', async () => {
    vi.setSystemTime(new Date('2026-11-15T17:00:00Z'))
    served = { hash: 'v2', calendar: [HEARING, MARKUP] }
    await tick(15)
    await tick(17)
    expect(await billCalendar()).toHaveLength(2)
  })
})

describe('an upgraded central', () => {
  // The central migrations before calendar identities were stored.
  const before0034: MigrationFiles = Object.fromEntries(
    Object.entries(legiscanMigrations).filter(([path]) => path.split('/').pop()! < '0034'))

  beforeEach(async () => {
    // A tracked bill whose calendar the old ingest wrote: no identities stored.
    await setupDb(before0034)
    await seed()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bills (bill_id, change_hash, session_id, state, state_id, bill_number, title, status)
        VALUES (${BILL}, 'v0', ${SESSION}, 'RI', 39, 'H1', 'Voter access act', 1)`),
      env.DB.prepare(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) VALUES (${BILL}, 'team', 'keyword')`),
      env.DB.prepare(`INSERT INTO bill_calendar (id, bill_id, type_id, event_hash, type, date, time, location, description) VALUES
        ('old-hearing', ${BILL}, 1, 'e-hearing', 'Hearing', '2026-10-20', '14:00', 'Room 35', 'House Cmte on Elections'),
        ('old-markup', ${BILL}, 3, 'e-markup', 'Markup Session', '2026-10-27', '10:00', 'Room 35', 'House Cmte on Elections')`),
    ])
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
  })

  it('keeps every entry under the identity instances already have, with nothing cancelled or added', async () => {
    const { sent } = await tick(13)
    expect(changes(sent[0])).toEqual([])
    expect(events(sent[0]).map((ev: any) => ev[0])).toEqual(['1|house cmte on elections', '3|house cmte on elections'])
    // The same rows, updated in place.
    const rows = await drizzle(env.DB, { schema }).select().from(schema.billCalendar).where(eq(schema.billCalendar.billId, BILL)).all()
    expect(rows.map(r => [r.id, r.identityKey]).sort()).toEqual([
      ['old-hearing', '1|house cmte on elections'],
      ['old-markup', '3|house cmte on elections'],
    ])
  })
})

describe('a provider that publishes event ids', () => {
  const zzQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  const zzEnv = () => ({ ...(env as any), [tenantQueueBindingName('zz')]: zzQueue, ADMIN_SECRET: 'test-secret' })
  const meetings = () => exampleFeed.records.find(r => r.Number === 'B26-0002')!.Meetings!

  /** The example provider's sync, then every message it queued. Returns the instance's calendar for B26-0002. */
  async function syncExample() {
    const db = drizzle(env.DB, { schema })
    const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
    const run = { ...zzEnv(), INGESTOR_QUEUE: ingestor }
    zzQueue.send.mockClear()
    await runSnapshotSync(example, run, db)
    for (const body of ingestor.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))) {
      await processIngestorQueue({ messages: [{ body, ack: vi.fn(), retry: vi.fn() }] } as any, run, db)
    }
    const billId = (await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'B26-0002')).get())!.billId
    return { billId, calendar: zzQueue.send.mock.calls.map(c => c[0]).find((m: any) => m.billId === `legiscan:${billId}`)?.calendar }
  }

  beforeEach(async () => {
    await setupDb(legiscanMigrations)
    exampleFeed.records = structuredClone(JSON.parse(exampleSessionRaw) as ExampleRecord[])
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tenants (tenant_id, name, state_coverage, active) VALUES ('zz', 'ZZ team', '["ZZ"]', 1)`),
      env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('zz', 'library')`),
    ])
    const { app } = await import('../../src/index-legiscan')
    const claim = await app.fetch(new Request('http://central/api/admin/state-providers/ZZ', {
      method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'example' }),
    }), zzEnv())
    expect(claim.status).toBe(200)
  })

  it('keeps a moved event under its id, and cancels it at once on the feed\'s removed flag', async () => {
    const first = await syncExample()
    expect(events(first)).toEqual([['id:M-301', 'meeting', '2026-10-14']])

    meetings()[0].Date = '2026-10-16'
    const moved = await syncExample()
    expect(changes(moved)).toEqual([['hearing_changed', 'id:M-301']])
    expect(events(moved)).toEqual([['id:M-301', 'meeting', '2026-10-16']])

    meetings()[0].Removed = true
    const removed = await syncExample()
    expect(changes(removed)).toEqual([['hearing_cancelled', 'id:M-301']])
    expect(removed.calendar.events).toEqual([])

    const { app } = await import('../../src/index-legiscan')
    const res = await app.fetch(new Request(`http://central/api/bills/legiscan:${removed.billId}`, { headers: { 'x-admin-secret': 'test-secret' } }), zzEnv())
    expect(((await res.json()) as any).calendar).toEqual([])
  })
})
