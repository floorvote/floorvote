import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'

// A LegiScan-only central upgrading onto the provider model: built from
// main's migrations, synced through the network (LegiScan's API stubbed with
// recorded-shape responses) in a full-pass hour and then a raw-pass hour, and
// checked only where an instance or the call budget would notice.

vi.mock('../../src/lib/sync-schedule', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/sync-schedule')>('../../src/lib/sync-schedule')
  return { ...actual, getCurrentEtHour: vi.fn(() => 5) }
})
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { runSync } from '../../src/cron/sync'
import { getCurrentEtHour } from '../../src/lib/sync-schedule'
import { processIngestorQueue } from '../../src/queue/processor'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

// Main's central migrations before this upgrade: everything up to
// 0021_session_votes_dataset. The contributor's 0021_lims_records and 0025
// onward arrive with the upgrade.
const onMain: MigrationFiles = Object.fromEntries(Object.entries(legiscanMigrations).filter(([path]) => {
  const name = path.split('/').pop()!
  return name < '0025' && name !== '0021_lims_records.sql'
}))

const session = (id: number, name: string) => ({ session_id: id, state_id: 39, year_start: 2026, year_end: 2026, session_name: name, session_tag: '', prior: 0, sine_die: 0 })
const entry = (id: number, number: string, hash: string, title: string) => ({
  bill_id: id, number, change_hash: hash, title, description: title, status: 1, status_date: '2026-01-10',
  last_action: 'Introduced', last_action_date: '2026-01-10', url: `https://legiscan.com/RI/bill/${number}/2026`,
})
const bill = (id: number, number: string, status: number, title: string) => ({
  bill_id: id, change_hash: `full-${id}`, session_id: 2154, state: 'RI', state_id: 39, bill_number: number,
  bill_type: 'B', bill_type_id: '1', body: 'H', body_id: 1, current_body: 'S', current_body_id: 2,
  title, description: title, status, status_date: '2026-03-01', pending_committee_id: 0,
  url: `https://legiscan.com/RI/bill/${number}/2026`, state_link: `https://webserver.rilegislature.gov/${number}`,
  session: { session_id: 2154, session_name: '2026 Regular Session', year_start: 2026, year_end: 2026 },
  committee: [], referrals: [], progress: [{ date: '2026-01-10', event: 1 }],
  sponsors: [{ people_id: 5001, name: 'Ann Able', party: 'D', role: 'Rep', role_id: 1, district: 'HD-001', sponsor_type_id: 1, sponsor_order: 1 }],
  history: [{ date: '2026-01-10', action: 'Introduced', chamber: 'H', chamber_id: 1, importance: 1 }],
  sasts: [], subjects: [], votes: [], calendar: [], amendments: [], supplements: [],
  texts: [{ doc_id: id * 10, date: '2026-01-10', type: 'Introduced', type_id: 1, mime: 'text/html', mime_id: 1,
    url: '', state_link: `https://webserver.rilegislature.gov/${number}.htm`, text_size: 0, text_hash: '',
    alt_bill_text: 0, alt_mime: '', alt_mime_id: 0, alt_state_link: '', alt_text_size: 0, alt_text_hash: '' }],
})

// What LegiScan answers, by op and id.
function legiscanResponse(op: string, id: string | null): unknown {
  switch (`${op}:${id ?? ''}`) {
    case 'getSessionList:':
      return { sessions: { 0: session(2200, '2027 Regular Session'), 1: session(2154, '2026 Regular Session') } }
    case 'getMasterList:2154':
      return { masterlist: {
        session: session(2154, '2026 Regular Session'),
        0: entry(9001, 'H1', 'h2', 'Voter access act'),
        1: entry(9002, 'H2', 'h1', 'Voter roll maintenance'),
        2: entry(9003, 'H3', 'h1', 'Bridge naming'),
      } }
    case 'getMasterList:2200':
      return { masterlist: { session: session(2200, '2027 Regular Session') } }
    // The raw list after the ingest: the stored hashes, and one new bill.
    case 'getMasterListRaw:2154':
      return { masterlist: {
        0: { bill_id: 9001, number: 'H1', change_hash: 'full-9001', title: 'Voter access act', description: '' },
        1: { bill_id: 9002, number: 'H2', change_hash: 'full-9002', title: 'Voter roll maintenance', description: '' },
        2: { bill_id: 9003, number: 'H3', change_hash: 'h1', title: 'Bridge naming', description: '' },
        3: { bill_id: 9004, number: 'H4', change_hash: 'h1', title: 'Harbor dredging', description: '' },
      } }
    case 'getMasterListRaw:2200':
      return { masterlist: {} }
    case 'getBill:9001':
      return { bill: bill(9001, 'H1', 2, 'Voter access act') }
    case 'getBill:9002':
      return { bill: bill(9002, 'H2', 1, 'Voter roll maintenance') }
  }
  throw new Error(`unexpected LegiScan call ${op} ${id}`)
}

const legiscanCalls = () => fetchMock.mock.calls
  .map(c => new URL(String(c[0])))
  .filter(u => u.hostname === 'api.legiscan.com')
  .map(u => `${u.searchParams.get('op')}:${u.searchParams.get('id') ?? u.searchParams.get('state')}`)

beforeEach(async () => {
  vi.clearAllMocks()
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.hostname !== 'api.legiscan.com') {
      return new Response('<html><body>bill text</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const body = legiscanResponse(url.searchParams.get('op')!, url.searchParams.get('id'))
    return Response.json({ status: 'OK', ...(body as object) })
  })

  // A central as main left it, with a tracked bill, a person, and a tenant.
  await setupDb(onMain)
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name)
      VALUES (2154, 39, 'RI', 2026, 2026, '', '2026 Regular Session', '2026 Regular Session')`),
    env.DB.prepare(`INSERT INTO tenants (tenant_id, name, state_coverage, active) VALUES ('team', 'Team', '["RI"]', 1)`),
    env.DB.prepare(`INSERT INTO keyword_registry (tenant_id, keyword) VALUES ('team', 'voter')`),
    env.DB.prepare(`INSERT INTO bills (bill_id, change_hash, session_id, state, state_id, bill_number, title, status)
      VALUES (9001, 'h1', 2154, 'RI', 39, 'H1', 'Voter access act', 1)`),
    env.DB.prepare(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) VALUES (9001, 'team', 'keyword')`),
    env.DB.prepare(`INSERT INTO people (people_id, name) VALUES (5001, 'Ann Able')`),
  ])

  // The upgrade: every migration main hasn't run, as a deploy applies them.
  await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
})

describe('a LegiScan-only central after the upgrade', () => {
  it('syncs, ingests, and notifies as before, with the same LegiScan calls', async () => {
    const db = drizzle(env.DB, { schema })
    const ingestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
    const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
    const e = { ...(env as any), INGESTOR_QUEUE: ingestor, [tenantQueueBindingName('team')]: tenantQueue, ADMIN_SECRET: 'test-secret' }

    // The 5 ET pass: refresh RI's sessions, then a full pass of each.
    await runSync(e, db)
    const queued = ingestor.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))
    expect(queued.map((m: any) => m.billId).sort()).toEqual([9001, 9002])
    for (const body of queued) {
      const retry = vi.fn()
      await processIngestorQueue({ messages: [{ body, ack: vi.fn(), retry }] } as any, e, db)
      expect(retry).not.toHaveBeenCalled()
    }

    // One session list, one master list per session, and one getBill per
    // queued bill. Texts come from the state's site, not getBillText.
    expect(legiscanCalls().sort()).toEqual(['getBill:9001', 'getBill:9002', 'getMasterList:2154', 'getMasterList:2200', 'getSessionList:RI'])

    // Every row is LegiScan's, old and new.
    for (const table of ['bills', 'sessions', 'people']) {
      const rows = (await env.DB.prepare(`SELECT DISTINCT provider FROM ${table}`).all<{ provider: string }>()).results
      expect(rows).toEqual([{ provider: 'legiscan' }])
    }

    // The bill API: LegiScan's labels and sponsor links.
    const { app } = await import('../../src/index-legiscan')
    const res = await app.fetch(new Request('http://central/api/bills/legiscan:9001', { headers: { 'x-admin-secret': 'test-secret' } }), e)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      billId: 'legiscan:9001', status: 'Engrossed', sessionName: '2026 Regular Session',
      sponsors: [{ name: 'Ann Able', url: 'https://legiscan.com/RI/people/Ann-Able/id/5001' }],
    })

    // What the tenant is sent: a monitor stub for the unmatched bill, and an
    // ingest notification for each matched one, with the status change.
    const sent = [
      ...tenantQueue.send.mock.calls.map(c => c[0]),
      ...tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
    ]
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ billId: 'legiscan:9003', stubOnly: true }),
      expect.objectContaining({ billId: 'legiscan:9001', matchType: 'keyword',
        changes: expect.arrayContaining([expect.objectContaining({ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed' })]) }),
      expect.objectContaining({ billId: 'legiscan:9002', matchType: 'keyword' }),
    ]))
    expect(sent).toHaveLength(3)

    // A raw-pass hour: one getMasterListRaw per session and nothing else. The
    // new bill's row is LegiScan's too, and nothing unchanged is queued.
    const callsBefore = legiscanCalls().length
    const rawIngestor = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(getCurrentEtHour).mockReturnValue(7)
    try {
      await runSync({ ...e, INGESTOR_QUEUE: rawIngestor }, db)
    } finally {
      vi.mocked(getCurrentEtHour).mockReturnValue(5)
    }
    expect(legiscanCalls().slice(callsBefore).sort()).toEqual(['getMasterListRaw:2154', 'getMasterListRaw:2200'])
    expect(rawIngestor.sendBatch).not.toHaveBeenCalled()
    const h4 = await env.DB.prepare('SELECT provider, session_id FROM bills WHERE bill_id = 9004').first()
    expect(h4).toEqual({ provider: 'legiscan', session_id: 2154 })
    for (const table of ['bills', 'sessions', 'people']) {
      const rows = (await env.DB.prepare(`SELECT DISTINCT provider FROM ${table}`).all<{ provider: string }>()).results
      expect(rows).toEqual([{ provider: 'legiscan' }])
    }
  })
})
