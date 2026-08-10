import { describe, it, expect, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'

// Every table runDemoReset writes. Ordered by primary key so the dump is
// deterministic across runs and across the refactor.
const TABLES = [
  'users', 'roles', 'user_roles', 'custom_field_definitions', 'association_config',
  'sessions', 'magic_links', 'official_positions', 'member_votes', 'comments',
  'comment_mentions', 'feed_events', 'bill_custom_field_values', 'notes',
  'calendar_events',
]

// The bills the NJ seed references. Seeded with deterministic ids of the form
// `bill-<external_id>` so every bill_id in the dump names the bill it points at —
// a swapped bill linkage shows up as a diff, not as UUID churn.
const NJ_BILL_EXTERNAL_IDS = [
  'legiscan:2099974', // A1129 — ballot drop boxes
  'legiscan:2100182', // A1195 — Voter Convenience Act
  'legiscan:2098535', // A1680 — voter registration 14 days
  'legiscan:2098113', // A1715 — John R. Lewis Voter Empowerment Act
  'legiscan:2098630', // A1698 — same-day voter registration
  'legiscan:2096183', // A251  — voting machines
  'legiscan:2099056', // A2670 — canvassing early votes
  'legiscan:2096553', // A548  — county clerk death filing
]

// Every now-relative value is normalized to a *signed whole-day offset from the
// run date* — `<d-60>` for 60 days ago, `<d+0>` for today, `<d+27>` for 27 days
// out. That encoding is both date-stable (the same `.snap` passes on any run
// date) and offset-pinning (a seed `daysAgo` or `offsetDays` typo shows up as a
// one-line diff). A constant placeholder would have given only the first.
const DAY = 86400_000
const dayBucket = (ms: number, baseMs: number): string => {
  const d = Math.round((ms - baseMs) / DAY)
  return `<d${d < 0 ? '' : '+'}${d}>`
}
/** UTC midnight of `baseMs` — the baseline date-only offsets are measured from. */
const utcMidnight = (baseMs: number) =>
  Date.parse(new Date(baseMs).toISOString().slice(0, 10) + 'T00:00:00Z')
/** Stored timestamps are SQLite space format in UTC, with no zone suffix. */
const parseDbTs = (v: string) => Date.parse(v.replace(' ', 'T').replace(/Z?$/, 'Z'))

// Columns written by the *SQL* clock rather than by a seed offset: a
// `datetime('now')` in the reset itself (users.last_seen_feed) or a column
// DEFAULT (all the rest). They carry no offset to pin, and no JS-level clock
// fake can move them, so they collapse to a constant instead of a day bucket —
// which is also what keeps the snapshot stable when the test fakes the clock.
// Verified empirically: with the JS clock faked, exactly these came back at real
// `now` while every other timestamp tracked the fake.
const SQL_CLOCK_COLUMNS = new Set([
  'users.last_active', 'users.last_seen_feed', 'roles.created_at',
  'custom_field_definitions.created_at', 'custom_field_definitions.updated_at',
  'official_positions.updated_at', 'notes.updated_at',
  'calendar_events.created_at', 'calendar_events.updated_at',
])

// The only date-only column the reset derives from the current date. Every other
// date-only value in the dump is an absolute seed date — the Implementation
// Deadline custom-field values, '2026-09-01' / '2026-11-01' / '2028-01-01' — and
// must stay literal. Bucketing those would reintroduce the run-date dependence
// this normalizer exists to remove, since they do not move with the clock.
const RELATIVE_DATE_COLUMNS = new Set(['calendar_events.date'])

const normalize = (table: string, col: string, v: unknown, baseMs: number): unknown => {
  if (typeof v !== 'string') return v
  const key = `${table}.${col}`
  if (SQL_CLOCK_COLUMNS.has(key)) return '<sql-now>'
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v)) return dayBucket(parseDbTs(v), baseMs)
  if (RELATIVE_DATE_COLUMNS.has(key) && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return dayBucket(Date.parse(v + 'T00:00:00Z'), utcMidnight(baseMs))
  }
  // A JSON config blob can embed an ISO instant (association_config.sessions
  // carries cachedAt), which would otherwise churn on every run.
  return v.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, (m) =>
    dayBucket(Date.parse(m.endsWith('Z') ? m : m + 'Z'), baseMs))
}

/** Stable, human-diffable dump of everything the reset produced. */
export async function dumpResetState(): Promise<string> {
  // Read the clock once so every bucket in one dump shares a baseline. This is
  // the JS clock, i.e. the one the reset itself derives its offsets from — and
  // the one `vi.setSystemTime` can move.
  const baseMs = Date.now()
  const out: string[] = []
  for (const t of TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all()
    const rows = (results as Record<string, unknown>[])
      // instance_preset is the one *intentional* difference between the pre- and
      // post-refactor output: the preset system is being retired, and the seed now
      // carries ai_context / relevance_question / tag_taxonomy / keywords directly.
      // Excluded here so this snapshot stays a pure transcription check rather than
      // failing on a change we meant to make. Its absence is asserted outright in
      // demoReset.test.ts ('does not set instance_preset').
      .filter(r => !(t === 'association_config' && r.key === 'instance_preset'))
      .map(r => JSON.stringify(Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, normalize(t, k, v, baseMs)]),
      )))
      .sort()
    out.push(`### ${t} (${rows.length})`, ...rows)
  }
  return out.join('\n')
}

/** A freshly migrated DB carrying every bill the NJ seed references. Without the
 *  bills the INSERT ... SELECT guards no-op and the dump is empty for the tables
 *  that matter most. */
async function freshlyMigratedWithBills() {
  await resetDb()
  await applyMigrations()
  for (const [i, extId] of NJ_BILL_EXTERNAL_IDS.entries()) {
    await seedBill({ id: `bill-${extId}`, externalId: extId, billNumber: `A${1000 + i}`, title: `Bill ${i}`, state: 'NJ', priority: 'high' })
  }
}

// Simulated run dates: one in the past, one in the future, and `null` for the
// real clock. Faking the clock moves the *JS* clock, which is what the reset
// derives its offsets from — including the date-only calendar_events.date that
// used to bake the recording date into this snapshot. It does NOT move the SQL
// clock, so SQL_CLOCK_COLUMNS stay at real `now`; those are normalized to a
// constant precisely because no JS-level fake can reach them.
const RUN_DATES = ['2025-03-05T12:00:00Z', '2027-11-21T03:00:00Z', null] as const

describe('demo reset golden snapshot', () => {
  afterEach(() => { vi.useRealTimers() })

  it('matches the recorded snapshot, identically on every run date', async () => {
    const dumps: string[] = []
    for (const runDate of RUN_DATES) {
      if (runDate === null) vi.useRealTimers()
      else { vi.useFakeTimers(); vi.setSystemTime(new Date(runDate)) }
      await freshlyMigratedWithBills()
      await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
      dumps.push(await dumpResetState())
    }
    vi.useRealTimers()

    // Assert date-independence *before* the snapshot, so a value that silently
    // re-anchored to the run date fails here — with a readable diff between two
    // run dates — instead of on some future morning against a stale recording.
    expect(dumps[1]).toBe(dumps[0])
    expect(dumps[2]).toBe(dumps[0])
    expect(dumps[0]).toMatchSnapshot()
  })
})
