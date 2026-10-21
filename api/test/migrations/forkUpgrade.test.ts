/// <reference types="vite/client" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, applyD1Migrations } from 'cloudflare:test'
import { resetDb, migrationsFromFiles } from '../helpers'
import { getDb } from '../../src/db/client'
import { processCentralNotification } from '../../src/queue/processor'
import { syncBodyEvents } from '../../src/lib/bodyEvents'
import { hearingUid } from '../../src/lib/hearingUid'
import { sessionToSlug } from '../../../shared/sessionSlug'
import forkManifestRaw from '../fixtures/fork/migrations.json?raw'
import forkRowsRaw from '../fixtures/fork/tenant-rows.json?raw'
import upstreamRaw from '../fixtures/fork/upstream-central.json?raw'

// The fork upgrade rehearsal, on the instance (#302): a downstream fork's
// instance, built from its own migrations folder and holding the rows its own
// code wrote, takes upstream's migrations, then what upstream's central sends
// it after the upgrade (recorded from central/test/cron/fork-upgrade.test.ts).
// Its own tables have to come through untouched, its bills and calendar
// entries keep the ids and UIDs its members' calendars and the fork's own
// features hold, and each Council hearing it shows is taken over in place.

vi.mock('../../src/lib/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/llm')>()
  return { ...actual, processBill: vi.fn().mockResolvedValue({ summary: 'Summary', tags: [], relevanceScore: 7 }) }
})

type Row = Record<string, unknown>
const forkManifest = JSON.parse(forkManifestRaw) as { files: string[] }
const forkRows = JSON.parse(forkRowsRaw) as { rows: Record<string, Row[]> }
const upstream = JSON.parse(upstreamRaw) as {
  notifications: any[]; bills: Record<string, unknown>; bodyEvents: { capabilities: unknown; events: any[] }; bodyEventOptions: unknown
}

const upstreamMigrations = import.meta.glob<string>('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true })
const forkOwnMigrations = import.meta.glob<string>('../fixtures/fork/migrations/*.sql', { query: '?raw', import: 'default', eager: true })

/** The fork's migrations folder: its own files, and upstream's files of every other name it holds. */
function forkMigrationFiles(): Record<string, string> {
  const byName = (files: Record<string, string>) => new Map(Object.entries(files).map(([path, sql]) => [path.split('/').pop()!, sql]))
  const own = byName(forkOwnMigrations)
  const shared = byName(upstreamMigrations)
  return Object.fromEntries(forkManifest.files.map(name => {
    const sql = own.get(name) ?? shared.get(name)
    if (sql === undefined) throw new Error(`the fork's ${name} is neither in its fixtures nor upstream`)
    return [name, sql]
  }))
}

/** The fork's own tables, from its 0071, 0072, and 0074. */
const FORK_TABLES = ['deep_analyses', 'team_links', 'crm_people', 'crm_contacts', 'crm_followups']

const bill = (externalId: string) => forkRows.rows.bills.find(b => b.external_id === externalId)!.id as string
const event = (uid: string) => forkRows.rows.calendar_events.find(e => e.uid === uid)!.id as string
const B0769 = bill('legiscan:1012600769')
const B0400 = bill('legiscan:1012600400')

async function rows(sql: string): Promise<Row[]> {
  return (await env.DB.prepare(sql).all<Row>()).results
}
async function forkTables() {
  return Object.fromEntries(await Promise.all(FORK_TABLES.map(async t => [t, await rows(`SELECT * FROM ${t} ORDER BY rowid`)])))
}
const calendarIds = () => rows('SELECT id, uid, sequence, status FROM calendar_events ORDER BY id')
/** What the team itself holds: priorities, tracking, votes, positions, comments, and notes. */
async function teamState() {
  return {
    bills: await rows('SELECT id, priority, match_type FROM bills ORDER BY id'),
    users: await rows('SELECT id, email, role FROM users ORDER BY id'),
    member_votes: await rows('SELECT id, user_id, bill_id, position FROM member_votes ORDER BY id'),
    official_positions: await rows('SELECT id, bill_id, position, notes FROM official_positions ORDER BY id'),
    comments: await rows('SELECT id, bill_id, user_id, content, deleted_at FROM comments ORDER BY id'),
    notes: await rows('SELECT id, bill_id, user_id, content FROM notes ORDER BY id'),
  }
}
/** Every table's row count. */
async function tableCounts() {
  const names = (await rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`)).map(r => r.name as string)
  return Object.fromEntries(await Promise.all(names.map(async t => [t, Number((await rows(`SELECT COUNT(*) AS n FROM ${t}`))[0].n)])))
}

/** The fork's instance: its migrations, its rows, and synthetic rows in its own tables. */
async function buildForkInstance() {
  await resetDb()
  await applyD1Migrations(env.DB, migrationsFromFiles(forkMigrationFiles()))
  // Parents first, for the foreign keys.
  const order = (t: string) => ['bills', 'calendar_events'].indexOf(t) + 1 || 3
  const tables = Object.entries(forkRows.rows).sort(([a], [b]) => order(a) - order(b))
  const statements = tables.flatMap(([table, list]) => list.map(row => {
    const cols = Object.keys(row)
    // OR REPLACE: migrations seed some rows (association_config), which the fork's replace.
    return env.DB.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map(c => row[c]))
  }))
  // The fork's own features, pointing at its bills and calendar events by id.
  // Synthetic rows: only that they survive, and still point somewhere, matters.
  const insert = (sql: string, ...values: unknown[]) => statements.push(env.DB.prepare(sql).bind(...values))
  insert(`INSERT INTO deep_analyses (id, kind, subject_id, status, input_hash, content, content_input_hash, model, completed_at) VALUES ('da-bill', 'bill', ?, 'done', 'in-1', 'An analysis.', 'in-1', 'model', '2026-09-28 10:00:00')`, B0769)
  insert(`INSERT INTO deep_analyses (id, kind, subject_id, status, input_hash) VALUES ('da-hearing', 'hearing', ?, 'pending', 'in-2')`, event('council-2405@lims.dccouncil.gov'))
  insert(`INSERT INTO team_links (id, subject_kind, subject_id, title, url) VALUES ('tl-bill', 'bill', ?, 'Comment letter', 'https://docs.example.org/letter')`, B0400)
  insert(`INSERT INTO team_links (id, subject_kind, subject_id, title, url) VALUES ('tl-event', 'event', ?, 'Testimony', 'https://docs.example.org/testimony')`, event('council-2428@lims.dccouncil.gov'))
  insert(`INSERT INTO crm_people (person_key, name, office, stance) VALUES ('cm:Zachary Parker', 'Zachary Parker', 'Ward 5', 'supportive')`)
  insert(`INSERT INTO crm_people (person_key, name, office) VALUES ('staff:staffer@example.org', 'Example Staffer', 'Committee on Youth Affairs')`)
  insert(`INSERT INTO crm_contacts (id, person_key, contact_date, kind, summary, bill_id) VALUES ('cc-1', 'cm:Zachary Parker', '2026-09-20', 'meeting', 'Talked through the stadium bill.', ?)`, B0769)
  insert(`INSERT INTO crm_followups (id, person_key, due_date, text) VALUES ('cf-1', 'staff:staffer@example.org', '2026-10-01', 'Send our testimony.')`)
  // What the team itself holds, which upstream's code must leave alone.
  // The fork's members carry the line under their name as `subtitle`. Migration 0105 copies it into a new `title` and keeps `subtitle`, and 0120 then drops `subtitle`.
  insert(`INSERT INTO users (id, email, name, role, subtitle) VALUES ('u-1', 'member@example.org', 'A Member', 'admin', 'Policy Lead'), ('u-2', 'other@example.org', 'Another Member', 'member', NULL)`)
  insert(`INSERT INTO member_votes (id, user_id, bill_id, position) VALUES ('mv-1', 'u-1', ?, 'support'), ('mv-2', 'u-2', ?, 'oppose')`, B0769, B0769)
  insert(`INSERT INTO official_positions (id, bill_id, position, notes, set_by) VALUES ('op-1', ?, 'Support', 'Testified in favor.', 'u-1')`, B0769)
  insert(`INSERT INTO comments (id, bill_id, user_id, content) VALUES ('c-1', ?, 'u-2', 'The hearing moved.')`, B0400)
  insert(`INSERT INTO notes (id, bill_id, user_id, content) VALUES ('n-1', ?, 'u-1', 'Ask about the fiscal note.')`, B0400)
  // A mention of u-1 in that comment, held in the table 0085 replaces.
  insert(`INSERT INTO comment_mentions (id, comment_id, user_id, source_type, source_id) VALUES ('cm-1', 'c-1', 'u-1', 'user', 'u-1')`)
  await env.DB.batch(statements)
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const testEnv = { ...env, TENANT_ID: 'oca', CENTRAL_API_URL: 'https://central.test', CENTRAL_ADMIN_SECRET: 'x', STATE: 'DC' } as any
/** Whether central answers the committee options call. An upgraded central does, within the hour. */
let centralListsOptions = false

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // The upgrade, the day after the fork's instance recorded its rows.
  vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
  centralListsOptions = false
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname === '/api/tenants/oca/body-events') return json(upstream.bodyEvents)
    if (url.pathname === '/api/tenants/oca/body-event-options') {
      return centralListsOptions ? json(upstream.bodyEventOptions) : new Response('unavailable', { status: 503 })
    }
    const billId = /^\/api\/bills\/(.+)$/.exec(decodeURIComponent(url.pathname))?.[1]
    if (billId && upstream.bills[billId]) return json(upstream.bills[billId])
    if (url.hostname === 'lims.dccouncil.gov') return new Response('%PDF-1.7\n%%EOF\n', { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    return new Response('not found', { status: 404 })
  }))
  await buildForkInstance()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a fork\'s instance, moved onto upstream', () => {
  it('takes every upstream migration, leaving its own tables and every bill and calendar id as they were', async () => {
    const before = await forkTables()
    const calendar = await calendarIds()
    const billIds = await rows('SELECT id, external_id FROM bills ORDER BY id')
    const team = await teamState()
    const counts = await tableCounts()
    expect(team.member_votes).toHaveLength(2)

    await applyD1Migrations(env.DB, migrationsFromFiles(upstreamMigrations))

    // No table loses a row, and what the team holds is as it was. 0085 moves
    // comment_mentions into notifications and drops it, so its rows are
    // counted there.
    const after = await tableCounts()
    const kept = { ...counts }
    const mentions = kept.comment_mentions ?? 0
    delete kept.comment_mentions
    expect(Object.entries(kept).filter(([t, n]) => !((after[t] ?? -1) >= n))).toEqual([])
    expect(mentions).toBe(1)
    expect(await rows(`SELECT id, recipient_id, kind, comment_id, actor_id FROM notifications`)).toEqual([
      { id: 'cm-1', recipient_id: 'u-1', kind: 'mention', comment_id: 'c-1', actor_id: 'u-2' },
    ])
    expect(await teamState()).toEqual(team)
    // 0105 copies each member's subtitle into the new title, and 0120 drops the subtitle, so the title is all that is left.
    expect(await rows(`SELECT * FROM users ORDER BY id`)).toEqual([
      expect.objectContaining({ id: 'u-1', title: 'Policy Lead' }),
      expect.objectContaining({ id: 'u-2', title: null }),
    ])
    expect((await rows(`PRAGMA table_info(users)`)).map(c => c.name)).not.toContain('subtitle')

    const applied = (await rows('SELECT name FROM d1_migrations ORDER BY id')).map(r => r.name)
    expect(applied.slice(0, forkManifest.files.length)).toEqual(forkManifest.files.map(f => f.replace(/\.sql$/, '')))
    expect(applied.slice(forkManifest.files.length)).toEqual(expect.arrayContaining(['0075_auth_events_email_changed', '0079_calendar_event_kind', '0082_calendar_event_covered_by']))
    expect(await forkTables()).toEqual(before)
    expect(await rows('SELECT id, external_id FROM bills ORDER BY id')).toEqual(billIds)
    expect(await calendarIds()).toEqual(calendar)
    // The fork's deadline row is a bill entry of kind deadline now (0079), and its Council rows wait for the mirror.
    expect(await rows(`SELECT source, kind, COUNT(*) AS n FROM calendar_events GROUP BY source, kind ORDER BY source, kind`)).toEqual([
      { source: 'council', kind: null, n: 9 },
      { source: 'hearing', kind: null, n: 6 },
      { source: 'hearing', kind: 'deadline', n: 1 },
    ])
    // LIMS statuses get a stage and rank, so the status sort and filter work (0076).
    expect(await rows(`SELECT bill_number, status, status_stage FROM bills WHERE match_type IS NOT NULL ORDER BY bill_number`)).toEqual([
      { bill_number: 'B26-0400', status: 'Official Law', status_stage: 'enacted' },
      { bill_number: 'B26-0769', status: 'Under Council Review', status_stage: 'in_committee' },
      { bill_number: 'HN26-0171', status: 'Not Applicable', status_stage: null },
      { bill_number: 'REPROG26-0153', status: 'New', status_stage: 'introduced' },
    ])
  })

  it('keeps every calendar UID and the fork\'s features\' links through what upstream\'s central sends next', async () => {
    await applyD1Migrations(env.DB, migrationsFromFiles(upstreamMigrations))
    const before = await forkTables()
    const team = await teamState()
    const calendar = new Map((await calendarIds()).map(r => [r.uid, r]))
    const db = getDb(env.DB)

    // The first DC sync and the LIMS re-ingest.
    for (const msg of upstream.notifications) await processCentralNotification(msg, testEnv, db)
    const afterBills = await calendarIds()
    expect(afterBills.map(r => r.uid).sort()).toEqual([...calendar.keys()].sort())
    for (const r of afterBills) {
      const was = calendar.get(r.uid)!
      expect(r.id).toBe(was.id)
      expect(r.status).toBe(was.status)
      // Only the second B26-0769 hearing changed, losing the fork's " (2)", so only its SEQUENCE moves.
      expect(r.sequence).toBe(r.uid === hearingUid('legiscan:1012600769', '1|public hearing on b26-0769 (2)', 'oca') ? Number(was.sequence) + 1 : was.sequence)
    }
    // Bill URLs keep the session slug the fork computed.
    expect(await rows(`SELECT DISTINCT session, session_slug FROM bills WHERE session_slug IS NOT NULL`)).toEqual([
      { session: '2025-2026 Council Period 26', session_slug: sessionToSlug('2025-2026 Council Period 26') },
    ])

    // The hourly body events mirror.
    const result = await syncBodyEvents(testEnv, db)
    const council = forkRows.rows.calendar_events.filter(e => e.source === 'council')
    expect(result).toMatchObject({ upserted: upstream.bodyEvents.events.length - council.length, cancelled: 0, removed: 0 })
    const after = new Map((await rows('SELECT id, uid, sequence, status, source, kind, covered_by, rule_match FROM calendar_events')).map(r => [r.uid, r]))
    // Each Council row the fork's rules picked is the same row under the same
    // UID, at the same SEQUENCE, since its hash is the fork's own.
    const sent = new Map(upstream.bodyEvents.events.map(e => [e.uid, e]))
    for (const e of council) {
      expect(after.get(e.uid as string)).toMatchObject({ id: e.id, sequence: e.sequence, status: 'confirmed', source: 'body', kind: sent.get(e.uid)!.kind })
    }
    // Every other Council event shows too. The fork's #217 rules wait for
    // central's committee list before they're carried over, so none are applied.
    expect([...after.values()].filter(r => r.source === 'body')).toHaveLength(upstream.bodyEvents.events.length)
    expect([...after.values()].filter(r => r.source === 'body' && r.rule_match !== null)).toEqual([])
    expect(await rows(`SELECT key FROM association_config WHERE key = 'event_rules'`)).toEqual([])
    // Each hearing shows once: the bill entries the Council's events cover point at them.
    expect(after.get(hearingUid('legiscan:1012600769', '1|public hearing on b26-0769', 'oca'))).toMatchObject({ covered_by: 'council-2405@lims.dccouncil.gov' })
    expect(after.get(hearingUid('legiscan:1082600171', '1|public oversight roundtable on department of behavioral health’s financial challenges', 'oca')))
      .toMatchObject({ covered_by: 'council-2428@lims.dccouncil.gov' })

    // The fork's own rows and the team's are untouched, and every bill and event they point at is still there.
    expect(await forkTables()).toEqual(before)
    expect(await teamState()).toEqual(team)
    expect(await rows(`
      SELECT 'deep_analyses' AS t, id FROM deep_analyses WHERE subject_id NOT IN (SELECT id FROM bills UNION SELECT id FROM calendar_events)
      UNION ALL SELECT 'team_links', id FROM team_links WHERE subject_id NOT IN (SELECT id FROM bills UNION SELECT id FROM calendar_events)
      UNION ALL SELECT 'crm_contacts', id FROM crm_contacts WHERE bill_id IS NOT NULL AND bill_id NOT IN (SELECT id FROM bills)`)).toEqual([])
  })

  it('carries the fork\'s Council calendar rules over as event rules once central lists its committees, so its team keeps the events it chose', async () => {
    await applyD1Migrations(env.DB, migrationsFromFiles(upstreamMigrations))
    const db = getDb(env.DB)
    for (const msg of upstream.notifications) await processCentralNotification(msg, testEnv, db)
    const legacy = await rows(`SELECT value FROM association_config WHERE key = 'council_calendar_rules'`)

    centralListsOptions = true
    await syncBodyEvents(testEnv, db)

    // Committee names become central's committees, #217's types event types, and its tracked-bills flag stays.
    const saved = await rows(`SELECT value FROM association_config WHERE key = 'event_rules'`)
    expect(saved.map(r => JSON.parse(r.value as string))).toEqual([{
      committees: [{ committeeId: '3000000003', name: 'Committee on Health' }, { committeeId: '3000000001', name: 'Committee on Youth Affairs' }],
      kinds: ['Oversight Hearing'],
      topics: [],
      trackedBills: true,
    }])
    // The events they select are the very ones the fork's own mirror picked. The rest are hidden.
    const council = forkRows.rows.calendar_events.filter(e => e.source === 'council').map(e => e.uid as string)
    const body = await rows(`SELECT uid, rule_match FROM calendar_events WHERE source = 'body' ORDER BY uid`)
    expect(body.filter(r => r.rule_match === 1).map(r => r.uid).sort()).toEqual([...council].sort())
    expect(body.filter(r => r.rule_match !== 1)).toEqual(
      upstream.bodyEvents.events.map(e => e.uid as string).filter(uid => !council.includes(uid)).sort().map(uid => ({ uid, rule_match: 0 })),
    )
    // The fork's own setting stays where it was, unread from here on.
    expect(await rows(`SELECT value FROM association_config WHERE key = 'council_calendar_rules'`)).toEqual(legacy)
  })
})
