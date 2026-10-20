import { applyD1Migrations, env } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'
import forkManifestRaw from '../fixtures/fork/migrations.json?raw'
import forkRowsRaw from '../fixtures/fork/central-rows.json?raw'
import bulkRaw from '../fixtures/lims/bulk-records.json?raw'
import details0400Raw from '../fixtures/lims/details-B26-0400.json?raw'
import detailsHnRaw from '../fixtures/lims/details-HN26-0171.json?raw'
import detailsReprogRaw from '../fixtures/lims/details-REPROG26-0153.json?raw'
import membersRaw from '../fixtures/lims/members-26.json?raw'
import { listedOnlyDetails } from '../helpers/limsListedOnly'
import calendarRaw from '../fixtures/lims/hearings-calendar.json?raw'

// The fork upgrade rehearsal (#302): a downstream fork's production central,
// built from its own migrations folder and holding the rows its own code wrote
// from the recorded LIMS fixtures, takes upstream's migrations and then
// upstream's DC sync, LIMS re-ingest, and Council calendar sync on the same
// fixtures. What its instances know DC by has to come through unchanged: bill
// ids, the identities their bill calendar UIDs are built from, and the UIDs
// of the Council's hearings. DC has to end up owned by LIMS, by the operator's
// claim (nothing else writes the row: the fork's LIMS_STATES, still set in its
// config, is ignored, #319), and the fork's own tables and columns left alone.
// An upgrade from a build older than #303 has no ownership row until that
// claim, which docs/internal/fork-upgrade.md makes the first step after deploy.
// api/test/migrations/forkUpgrade.test.ts does the same for its instance.
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
import { runSync } from '../../src/cron/sync'
import { assignSessionSlugs } from '../../src/lib/sessionSlugs'
import { processIngestorQueue } from '../../src/queue/processor'
import { lims } from '../../src/providers/lims'
import { tenantQueueBindingName } from '../../src/lib/tenantQueue'

type Row = Record<string, unknown>
const forkManifest = JSON.parse(forkManifestRaw) as { files: string[] }
const forkRows = JSON.parse(forkRowsRaw) as { calendarIdentities: Record<string, string[]>; rows: Record<string, Row[]> }
const forkOwnMigrations: MigrationFiles = import.meta.glob<string>(
  '../fixtures/fork/migrations-legiscan/*.sql', { query: '?raw', import: 'default', eager: true },
)

/**
 * The fork's migrations folder: its own files, and upstream's files of every
 * other name it holds (byte-identical, since no migration is ever edited).
 */
function forkMigrationFiles(): MigrationFiles {
  const byName = (files: MigrationFiles) => new Map(Object.entries(files).map(([path, sql]) => [path.split('/').pop()!, sql]))
  const own = byName(forkOwnMigrations)
  const upstream = byName(legiscanMigrations)
  return Object.fromEntries(forkManifest.files.map(name => {
    const sql = own.get(name) ?? upstream.get(name)
    if (sql === undefined) throw new Error(`the fork's ${name} is neither in its fixtures nor upstream`)
    return [name, sql]
  }))
}

/** Its own tables, which no upstream migration or code may touch. */
const FORK_TABLES = ['council_events', 'council_committees', 'council_directory', 'council_committee_history', 'council_changes']
/** Its own columns on a shared table. */
const FORK_PEOPLE_COLUMNS = ['people_id', 'term_start', 'term_end', 'seated']

const LIMS = 'https://lims.dccouncil.gov/api/v2/PublicData/'
const HEARINGS = 'https://lims.dccouncil.gov/Hearings/API/Public/GetHearingsCalendar'
const PDF = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
const CP26 = { councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }
const CATEGORY_IDS: Record<string, number> = {
  'Bill': 1, 'Resolution': 6, 'Grant Budget Modification': 13, 'Reprogramming': 14, 'Oversight Hearing/Roundtable Notice': 18,
}
const bulk = JSON.parse(bulkRaw) as Record<string, Record<string, any>>
// The feed the fork recorded its rows from: B26-0769 has a second public
// hearing with the same text, which the fork's ingest numbered " (2)".
bulk['B26-0769'] = {
  ...bulk['B26-0769'],
  legislationHistory: [...bulk['B26-0769'].legislationHistory,
    { legislationNumber: 'B26-0769', actionDate: 'Nov 06, 2026', actionDescription: 'Public Hearing on B26-0769', downloadURL: '' }],
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const feed: Record<string, () => Response> = {
  'LegislationDetails/B26-0001': () => json(listedOnlyDetails('B26-0001', 80)),
  'LegislationDetails/PR26-0808': () => json(listedOnlyDetails('PR26-0808', 82)),
  'LegislationDetails/GBM26-0061': () => json(listedOnlyDetails('GBM26-0061', 83)),
  'CouncilPeriods': () => json([CP26]),
  'Members/26': () => json(JSON.parse(membersRaw)),
  'LegislationDetails/B26-0400': () => json(JSON.parse(details0400Raw)),
  'LegislationDetails/HN26-0171': () => json(JSON.parse(detailsHnRaw)),
  'LegislationDetails/REPROG26-0153': () => json(JSON.parse(detailsReprogRaw)),
  'LegislationDetails/B26-0769': () => json({
    ...JSON.parse(details0400Raw), legislationNumber: 'B26-0769', status: 'Under Council Review',
    committeeHearing: [], committeeMarkup: [], actions: [], otherDocuments: [], mayoralReview: null, congressionalReview: null,
  }),
  ...Object.fromEntries(Object.entries(CATEGORY_IDS).map(([name, id]) =>
    [`BulkData/${id}/26`, () => json(Object.values(bulk).filter(r => r.legislationCategory === name))])),
}
const october = (JSON.parse(calendarRaw) as Record<string, unknown[]>)['2026-10']

/** The fork's central env after the upgrade: its LIMS key, and the LIMS_STATES it hasn't removed yet. */
function makeEnv() {
  const limsQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() }
  const tenantQueue = { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn().mockResolvedValue(undefined) }
  return {
    limsQueue, tenantQueue,
    env: {
      ...(env as any),
      LIMS_API_KEY: 'lims-key',
      LIMS_STATES: 'DC',
      LIMS_INGESTOR_QUEUE: limsQueue,
      INGESTOR_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined), send: vi.fn() },
      [tenantQueueBindingName('oca')]: tenantQueue,
    },
  }
}
type Run = ReturnType<typeof makeEnv>
const db = () => drizzle(env.DB, { schema })

async function central(method: string, path: string, run: Run) {
  const { app } = await import('../../src/index')
  return app.fetch(new Request(`http://central/api${path}`, { method, headers: { 'x-admin-secret': 'test-secret' } }), run.env)
}
async function app(run: Run, method: string, path: string, body: unknown) {
  const { app } = await import('../../src/index')
  return app.fetch(new Request(`http://central/api${path}`, {
    method, headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), run.env)
}
/** The operator's first step after deploying central: claim DC for LIMS. */
async function claimDc(run: Run) {
  const res = await app(run, 'POST', '/admin/state-providers/DC', { provider: 'lims' })
  expect(res.status).toBe(200)
}
async function getJson(path: string, run = makeEnv()) {
  const res = await central('GET', path, run)
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

/** Every message the run queued on LIMS's ingest queue, ingested. */
async function ingestQueued(run: Run) {
  const messages = run.limsQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body))
    .map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
  if (messages.length > 0) await processIngestorQueue({ messages } as any, run.env, db())
  for (const m of messages) expect(m.retry).not.toHaveBeenCalled()
  return messages.map(m => m.body)
}
const sentToTenant = (run: Run) => [
  ...run.tenantQueue.send.mock.calls.map(c => c[0]),
  ...run.tenantQueue.sendBatch.mock.calls.flatMap(c => c[0].map((m: any) => m.body)),
]

async function rows(sql: string): Promise<Row[]> {
  return (await env.DB.prepare(sql).all<Row>()).results
}
/** What instances and their members hold through central, in the fork's own columns. */
const HELD: Record<string, string> = {
  bill_tenants: 'SELECT bill_id, tenant_id, match_type FROM bill_tenants ORDER BY bill_id, tenant_id',
  roll_calls: 'SELECT roll_call_id, bill_id, date, description, yea, nay, nv, absent, total, passed FROM roll_calls ORDER BY roll_call_id',
  roll_call_votes: 'SELECT roll_call_id, people_id, vote_id, vote_text FROM roll_call_votes ORDER BY roll_call_id, people_id',
  bill_history: 'SELECT bill_id, date, action, chamber, seq FROM bill_history ORDER BY bill_id, seq, date, action',
}
async function heldState() {
  return Object.fromEntries(await Promise.all(Object.entries(HELD).map(async ([t, sql]) => [t, await rows(sql)])))
}
/** Every table's row count. */
async function tableCounts() {
  const names = (await rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`)).map(r => r.name as string)
  return Object.fromEntries(await Promise.all(names.map(async t => [t, Number((await rows(`SELECT COUNT(*) AS n FROM ${t}`))[0].n)])))
}
async function forkState() {
  const tables: Record<string, Row[]> = {}
  for (const t of FORK_TABLES) tables[t] = await rows(`SELECT * FROM ${t} ORDER BY rowid`)
  return { tables, people: await rows(`SELECT ${FORK_PEOPLE_COLUMNS.join(', ')} FROM people ORDER BY people_id`) }
}

/** The fork's production central: its migrations, its rows, and synthetic directory rows. */
async function buildForkCentral() {
  await setupDb(forkMigrationFiles())
  const statements = Object.entries(forkRows.rows).flatMap(([table, list]) => list.map(row => {
    const cols = Object.keys(row)
    // OR REPLACE: migrations seed some rows (settings), which the fork's replace.
    return env.DB.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map(c => row[c]))
  }))
  // The directory tables the fork fills from dccouncil.gov. Synthetic rows,
  // since only their survival matters here.
  statements.push(
    env.DB.prepare(`INSERT INTO council_committees (slug, name, url, chair_json, members_json, staff_json, agencies_json) VALUES ('committee-on-youth-affairs', 'Committee on Youth Affairs', 'https://dccouncil.gov/committees/youth-affairs/', '{"name":"Zachary Parker"}', '[{"name":"Zachary Parker"}]', '[{"name":"Example Staffer","title":"Committee Director"}]', '[]')`),
    env.DB.prepare(`INSERT INTO council_directory (entry_key, kind, name, title, office, email, phone) VALUES ('staffer@example.org|example staffer|committee on youth affairs', 'staff', 'Example Staffer', 'Committee Director', 'Committee on Youth Affairs', 'staffer@example.org', '202-555-0100')`),
    env.DB.prepare(`INSERT INTO council_committee_history (slug, valid_from, valid_to, name, chair, members_json, staff_json) VALUES ('committee-on-youth-affairs', '2026-09-28 09:00:00', NULL, 'Committee on Youth Affairs', 'Zachary Parker', '[]', '[]')`),
    env.DB.prepare(`INSERT INTO council_changes (detected_at, kind, committee, person, detail) VALUES ('2026-09-28 09:00:00', 'staff_joined', 'committee-on-youth-affairs', 'Example Staffer', 'Committee Director')`),
    env.DB.prepare(`UPDATE people SET seated = CASE WHEN name = 'Anita Bonds' THEN 0 ELSE 1 END`),
  )
  await env.DB.batch(statements)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // The day after the fork recorded its rows, at 5 ET: the upgrade.
  vi.setSystemTime(new Date('2026-09-29T09:00:00Z'))
  vi.clearAllMocks()
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === HEARINGS) {
      const { month, year } = JSON.parse(String(init?.body)) as { month: string; year: string }
      return json(`${year}-${month.padStart(2, '0')}` === '2026-10' ? october : [])
    }
    if (url.startsWith('https://api.legiscan.com/')) return json({ status: 'OK', sessions: [], masterlist: {} })
    if (url.startsWith(LIMS)) return feed[url.slice(LIMS.length)]?.() ?? new Response('not found', { status: 404 })
    if (url.startsWith('https://lims.dccouncil.gov/downloads/')) return new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
    throw new Error(`no network in this test: ${url}`)
  })
  await buildForkCentral()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a fork\'s production central, moved onto upstream', () => {
  it('takes every upstream migration, keeping its rows, its own tables, and its own columns', async () => {
    const before = await forkState()
    const dcBills = await rows(`SELECT bill_id, bill_number, session_id FROM bills WHERE state = 'DC' ORDER BY bill_id`)
    const calendar = await rows('SELECT id, bill_id, type_id, date, description, event_hash FROM bill_calendar ORDER BY id')
    expect(dcBills).toHaveLength(7)
    const held = await heldState()
    const counts = await tableCounts()

    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))

    // No table loses a row but lims_records, which is copied into provider_records and dropped.
    const after = await tableCounts()
    expect(Object.entries(counts).filter(([t, n]) => t !== 'lims_records' && !((after[t] ?? -1) >= n))).toEqual([])
    // Instances' links, and the votes and history members see, as they were.
    expect(await heldState()).toEqual(held)

    // Wrangler applies only the names it hasn't: upstream's own files.
    const applied = (await rows('SELECT name FROM d1_migrations ORDER BY id')).map(r => r.name as string)
    expect(applied.slice(0, forkManifest.files.length)).toEqual(forkManifest.files.map(f => f.replace(/\.sql$/, '')))
    expect(applied.slice(forkManifest.files.length)).toEqual(expect.arrayContaining(['0021_lims_records', '0025_source_provenance', '0030_state_providers', '0037_body_events']))

    expect(await forkState()).toEqual(before)
    expect(await rows(`SELECT bill_id, bill_number, session_id FROM bills WHERE state = 'DC' ORDER BY bill_id`)).toEqual(dcBills)
    // Every DC row is LIMS's, from the ranges its ids were packed into.
    expect(await rows(`SELECT DISTINCT provider FROM bills WHERE state = 'DC'`)).toEqual([{ provider: 'lims' }])
    expect(await rows(`SELECT DISTINCT provider, session_tag FROM sessions WHERE state = 'DC'`)).toEqual([{ provider: 'lims', session_tag: 'CP26' }])
    expect(await rows(`SELECT COUNT(*) AS n FROM people WHERE provider = 'lims'`)).toEqual([{ n: before.people.length }])
    // lims_records is copied into provider_records, then dropped.
    expect(await rows(`SELECT bill_id, provider, native_key FROM provider_records ORDER BY bill_id`))
      .toEqual(forkRows.rows.lims_records.map(r => ({ bill_id: r.bill_id, provider: 'lims', native_key: r.legislation_number })).sort((a, b) => Number(a.bill_id) - Number(b.bill_id)))
    expect(await rows(`SELECT name FROM sqlite_master WHERE name = 'lims_records'`)).toEqual([])
    // Calendar rows stay as the fork wrote them, with no identity stored, so
    // each keeps the identity its instances' UIDs were built from.
    expect(await rows('SELECT id, bill_id, type_id, date, description, event_hash FROM bill_calendar ORDER BY id')).toEqual(calendar)
    expect(await rows('SELECT DISTINCT identity_key, cancelled_at, missed_pulls FROM bill_calendar')).toEqual([{ identity_key: null, cancelled_at: null, missed_pulls: 0 }])
    // No ownership row: no migration writes one, and the operator's claim does.
    expect(await rows('SELECT * FROM state_providers')).toEqual([])
  })

  it('leaves DC unowned and unsynced by LIMS until it is claimed, though LIMS_STATES still names it', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    const before = await forkState()
    const dcBills = await rows(`SELECT bill_id, provider FROM bills WHERE state = 'DC' ORDER BY bill_id`)
    const log = vi.spyOn(console, 'log')

    const first = makeEnv()
    expect(await runSnapshotSync(lims, first.env, db())).toEqual([])
    await runBodyEventSync(lims, first.env, db())
    await ingestQueued(first)

    // Nothing wrote a row, so DC is LegiScan's, and LIMS fetched nothing.
    expect(await rows('SELECT * FROM state_providers')).toEqual([])
    expect((await getJson('/admin/state-providers')).states).toEqual([])
    expect(first.limsQueue.sendBatch).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/seeded from|LIMS_STATES/)
    expect(await rows(`SELECT bill_id, provider FROM bills WHERE state = 'DC' ORDER BY bill_id`)).toEqual(dcBills)
    expect(await forkState()).toEqual(before)
  })

  it.each([
    ['with LIMS_STATES still set', true],
    ['with LIMS_STATES removed', false],
  ])('syncs DC from LIMS once the operator claims it, %s, as the guide\'s first step after deploying, under the bill ids instances have', async (_label, keepVar) => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    const before = await forkState()
    const run = makeEnv()
    if (!keepVar) delete (run.env as Record<string, unknown>).LIMS_STATES
    const res = await app(run, 'POST', '/admin/state-providers/DC', { provider: 'lims' })
    expect(res.status).toBe(200)
    expect((await getJson('/admin/state-providers', run)).states).toEqual([
      expect.objectContaining({ state: 'DC', provider: 'lims', status: 'active', previousProvider: 'legiscan' }),
    ])

    await runSnapshotSync(lims, run.env, db())
    await ingestQueued(run)
    // Every bill the fork had keeps its id, and no DC bill is added twice.
    for (const bill of forkRows.rows.bills) {
      expect(await getJson(`/bills/legiscan:${bill.bill_id}`)).toMatchObject({ billId: `legiscan:${bill.bill_id}`, number: bill.bill_number, state: 'DC' })
    }
    expect(await rows(`SELECT bill_id FROM bills WHERE state = 'DC' ORDER BY bill_id`))
      .toEqual(forkRows.rows.bills.map(b => ({ bill_id: b.bill_id })).sort((a, b) => Number(a.bill_id) - Number(b.bill_id)))
    expect(sentToTenant(run).map(m => m.billId)).toEqual(expect.arrayContaining(['legiscan:1012600769']))
    expect(await forkState()).toEqual(before)
  })

  it('refuses the claim and keeps DC on LegiScan if the old code wrote a DC bill after the migrations, until the guide\'s fix relabels it', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    // The fork's old LIMS sync, still deployed, writes a new bill without a
    // provider, so the column's default calls it LegiScan's, and links it.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bills (bill_id, session_id, state, state_id, bill_number, change_hash, title) VALUES (1012600999, 1000000026, 'DC', 51, 'B26-0999', 'h', 'A bill written between migrating and deploying')`),
      env.DB.prepare(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) VALUES (1012600999, 'oca', 'keyword')`),
    ])
    const refused = makeEnv()
    // LIMS_STATES no longer seeds DC, so the sync has nothing to refuse and nothing to do.
    await runSnapshotSync(lims, refused.env, db())
    expect(refused.limsQueue.sendBatch).not.toHaveBeenCalled()
    // The claim is refused, naming the instance that tracks the mislabeled bill.
    const res = await app(refused, 'POST', '/admin/state-providers/DC', { provider: 'lims' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ owner: 'legiscan', trackedBills: 1, instances: ['oca'] })
    expect((await getJson('/admin/state-providers')).states).toEqual([])

    await env.DB.prepare(`UPDATE bills SET provider = 'lims' WHERE state = 'DC' AND provider = 'legiscan' AND bill_id >= 1000000000 AND bill_id < 2000000000`).run()
    await claimDc(makeEnv())
    await runSnapshotSync(lims, makeEnv().env, db())
    expect((await getJson('/admin/state-providers')).states).toEqual([expect.objectContaining({ state: 'DC', provider: 'lims' })])
  })

  it('claims DC after the first cron tick, which slugs sessions before any claim: the claim answers 200 and the Council Period keeps its plain slug', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    // The first tick after deploying runs the slug job and the LegiScan sync,
    // with DC unowned. A guard rather than a red test: the fork holds only LIMS
    // DC sessions, so nothing LegiScan's can take the plain slug.
    await assignSessionSlugs(db())
    await runSync(makeEnv().env, db())
    const slug = () => rows(`SELECT slug FROM sessions WHERE session_id = 1000000026`)
    expect(await slug()).toEqual([{ slug: 'cp26' }])

    const run = makeEnv()
    expect((await app(run, 'POST', '/admin/state-providers/DC', { provider: 'lims' })).status).toBe(200)
    await assignSessionSlugs(db())
    expect(await slug()).toEqual([{ slug: 'cp26' }])
  })

  it('leaves the Council Period with "-2" for good when a LegiScan DC session took the plain slug before the claim', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    await env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_title, session_name, provider)
      VALUES (2050, 9, 'DC', 2025, 2026, '2025-2026 Council Period 26', '2025-2026 Council Period 26', 'legiscan')`).run()
    await assignSessionSlugs(db())
    await app(makeEnv(), 'POST', '/admin/state-providers/DC', { provider: 'lims' })
    await assignSessionSlugs(db())
    expect(await rows(`SELECT session_id, slug FROM sessions WHERE session_id IN (2050, 1000000026) ORDER BY session_id`))
      .toEqual([{ session_id: 2050, slug: 'cp26' }, { session_id: 1000000026, slug: 'cp26-2' }])
  })

  it('keeps the identity of every bill calendar entry instances hold, through the LIMS re-ingest', async () => {
    const held = await heldState()
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    const first = makeEnv()
    await claimDc(first)
    await runSnapshotSync(lims, first.env, db())
    await ingestQueued(first)

    // The guide's post-deploy step: re-ingest the instance's DC bills from LIMS.
    const run = makeEnv()
    const res = await central('POST', '/admin/reingest-tenant/oca?provider=lims&confirm=true', run)
    expect(await res.json()).toMatchObject({ provider: 'lims', dryRun: false })
    await ingestQueued(run)

    // The latest calendar each bill's instance got, and every change it was told of.
    const calendars = new Map<string, any>()
    const changes = new Map<string, string[][]>()
    for (const m of [...sentToTenant(first), ...sentToTenant(run)]) {
      if (!m.calendar) continue
      calendars.set(m.billId, m.calendar)
      changes.set(m.billId, [...(changes.get(m.billId) ?? []), ...m.calendar.changes.map((c: any) => [c.changeType, c.identityKey])])
    }
    // Every bill the fork held entries for. Others get their first ingest here too (LIMS declares
    // ingestAll, #835), and with it entries the fork never sent, which this test doesn't follow.
    const forkBills = Object.keys(forkRows.calendarIdentities)
    expect([...calendars.keys()]).toEqual(expect.arrayContaining(forkBills))
    for (const [billId, identities] of Object.entries(forkRows.calendarIdentities)) {
      expect(calendars.get(billId).events.map((e: any) => e.identityKey).sort()).toEqual([...identities].sort())
      // Nothing added or cancelled. Only the second hearing changes, once: its text loses the fork's " (2)".
      expect(changes.get(billId)).toEqual(billId === 'legiscan:1012600769' ? [['hearing_changed', '1|public hearing on b26-0769 (2)']] : [])
    }
    // The fork's deadline is a deadline now, under the identity it had.
    expect(calendars.get('legiscan:1012600400').events.find((e: any) => e.identityKey === '10|mayor\'s response due')).toMatchObject({ kind: 'deadline' })
    // Instances keep their links, and the re-ingest keeps every roll call, vote, and history line.
    const now = await heldState()
    expect(now.bill_tenants).toEqual(held.bill_tenants)
    for (const t of ['roll_calls', 'roll_call_votes', 'bill_history']) expect(now[t]).toEqual(expect.arrayContaining(held[t]))
    // One row per entry, each now holding the identity instances know it by.
    expect(await rows(`SELECT identity_key FROM bill_calendar WHERE cancelled_at IS NULL
      AND bill_id IN (${forkBills.map(h => Number(h.split(':')[1])).join(', ')}) ORDER BY identity_key`))
      .toEqual(Object.values(forkRows.calendarIdentities).flat().sort().map(identity_key => ({ identity_key })))
  })

  it('sends each Council hearing under the UID and hash the fork\'s instances already hold', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    // The calendar job can run before the claim, and before any DC bill is
    // ingested again. It writes no row: DC is claimed, and only then synced.
    await runBodyEventSync(lims, makeEnv().env, db())
    expect((await getJson('/admin/state-providers')).states).toEqual([])
    expect((await getJson('/tenants/oca/body-events?from=2026-08-01&to=2026-12-31')).events).toEqual([])
    await claimDc(makeEnv())
    await runBodyEventSync(lims, makeEnv().env, db())
    expect((await getJson('/admin/state-providers')).states).toEqual([expect.objectContaining({ state: 'DC', provider: 'lims' })])

    const { capabilities, events } = await getJson('/tenants/oca/body-events?from=2026-08-01&to=2026-12-31')
    expect(capabilities).toEqual({ DC: { bodyEvents: true, deadlines: true, bodyName: 'Council' } })
    const byUid = new Map<string, any>(events.map((e: any) => [e.uid, e]))
    const council = forkRows.rows.council_events
    expect(events).toHaveLength(council.length)
    for (const e of council) {
      expect(byUid.get(`council-${e.hearing_id}@lims.dccouncil.gov`)).toMatchObject({ date: e.date, eventHash: e.event_hash, cancelled: false })
    }
    // The hearing covers B26-0769's entry under the identity its instances
    // hold, though the row stores none until its next ingest.
    expect(byUid.get('council-2405@lims.dccouncil.gov')).toMatchObject({
      bills: ['legiscan:1012600769'],
      covers: [{ billId: 'legiscan:1012600769', identityKey: '1|public hearing on b26-0769' }],
    })
    // The fork's council_events is left for its operator to drop.
    expect(await rows('SELECT COUNT(*) AS n FROM council_events')).toEqual([{ n: council.length }])
  })
})
