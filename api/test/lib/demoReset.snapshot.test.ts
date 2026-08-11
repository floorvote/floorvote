// GOLDEN SNAPSHOT — __snapshots__/demoReset.snapshot.test.ts.snap is a full dump
// of every row runDemoReset writes. It guards the faithfulness of the seed
// transcription: a mistyped bill id, a swapped persona, a dropped comment, or a
// day offset off by one shows up as a one-line diff instead of shipping to the
// demo. UPDATE RULE: regenerate (`vitest -u`) ONLY when you deliberately changed
// seed data, and say which rows you expected to move. Never run -u to turn an
// unexplained red green — an unexpected diff is the bug this file exists to catch.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { runDemoReset, dateFromNow } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'

// Every table runDemoReset writes. Ordered by primary key so the dump is
// deterministic across runs and across the refactor.
const TABLES = [
  'users', 'roles', 'user_roles', 'custom_field_definitions', 'association_config',
  'sessions', 'magic_links', 'official_positions', 'member_votes', 'comments',
  'comment_mentions', 'comment_reactions', 'feed_events', 'bill_custom_field_values', 'notes',
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
// `calendar_events.date` USED to live here, bucketed as a relative day offset.
// It can't be: demoReset's dateFromNow now snaps calendar dates off the weekend,
// so the delta between the reset date and the stored date is
// weekday-dependent — k, k+1, or k+2 for the same seed offset — and therefore
// NOT stable across the run dates this file deliberately varies. Bucketing it
// would make the snapshot fail on five days out of seven.
//
// Collapsing it to a constant would lose the offset pinning, so it is pinned
// outside the snapshot instead, by the 'calendar dates' describe block below:
// that recomputes each expected date from the seed's own offsetDays for the
// current run date, which checks strictly more than a bucket did — the seed's
// declared offset AND the machinery's snapping arithmetic.
const SNAPPED_DATE_COLUMNS = new Set(['calendar_events.date'])
const RELATIVE_DATE_COLUMNS = new Set<string>()

// SQL_CLOCK_COLUMNS values carry no offset to pin (see comment above), but that
// also means a future edit that *did* start writing a seed offset into one of
// these columns would have the offset silently swallowed into the same
// '<sql-now>' constant every real-clock run already produces — the collapse
// would hide the bug instead of catching it. So verify the premise directly:
// each of these must actually be near real wall-clock time. `realNowMs` is
// `vi.getRealSystemTime()`, not `Date.now()` — the whole point of these columns
// is that they track the real clock even while the JS clock is faked for the
// RUN_DATES loop, so the reference point must be real too.
const SQL_CLOCK_TOLERANCE_MS = 30_000

const normalize = (table: string, col: string, v: unknown, baseMs: number, realNowMs: number): unknown => {
  if (typeof v !== 'string') return v
  const key = `${table}.${col}`
  if (SQL_CLOCK_COLUMNS.has(key)) {
    const drift = Math.abs(parseDbTs(v) - realNowMs)
    expect(drift, `${key} = ${v} should be within ${SQL_CLOCK_TOLERANCE_MS}ms of real now, was off by ${drift}ms`)
      .toBeLessThan(SQL_CLOCK_TOLERANCE_MS)
    return '<sql-now>'
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(v)) return dayBucket(parseDbTs(v), baseMs)
  if (SNAPPED_DATE_COLUMNS.has(key) && /^\d{4}-\d{2}-\d{2}$/.test(v)) return '<snapped-date>'
  if (RELATIVE_DATE_COLUMNS.has(key) && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return dayBucket(Date.parse(v + 'T00:00:00Z'), utcMidnight(baseMs))
  }
  // A JSON config blob can embed an ISO instant (association_config.sessions
  // carries cachedAt), which would otherwise churn on every run.
  return v.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, (m) =>
    dayBucket(Date.parse(m.endsWith('Z') ? m : m + 'Z'), baseMs))
}

/**
 * Stable, human-diffable dump of everything the reset produced.
 *
 * `baseMs` must be read by the caller *before* calling `runDemoReset`, not
 * after — reading it here (after the reset) leaves a window where a real-clock
 * run that happens to straddle UTC midnight between the reset's writes and this
 * read shifts every `calendar_events.date` bucket by one and fails. Requiring
 * the caller to pass it in removes that window instead of narrowing it.
 * `realNowMs` should be `vi.getRealSystemTime()` — the actual wall clock, used
 * to verify SQL_CLOCK_COLUMNS (see normalize above).
 */
export async function dumpResetState(baseMs: number, realNowMs: number): Promise<string> {
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
        Object.entries(r).map(([k, v]) => [k, normalize(t, k, v, baseMs, realNowMs)]),
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
      // Read before runDemoReset, not after — see dumpResetState's doc comment.
      const baseMs = Date.now()
      const realNowMs = vi.getRealSystemTime()
      await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
      dumps.push(await dumpResetState(baseMs, realNowMs))
    }
    vi.useRealTimers()

    // Assert date-independence *before* the snapshot, so a value that silently
    // re-anchored to the run date fails here — with a readable diff between two
    // run dates — instead of on some future morning against a stale recording.
    expect(dumps[1]).toBe(dumps[0])
    expect(dumps[2]).toBe(dumps[0])
    expect(dumps[0]).toMatchSnapshot()
  })

  it('is immune to a UTC-midnight crossing between the reset and the dump', async () => {
    // Regression for the flake this test used to carry: baseMs read *after*
    // runDemoReset meant a real-clock run straddling UTC midnight between the
    // reset's writes and the dump's read shifted every calendar_events.date
    // bucket by one. Simulate exactly that straddle and confirm the dump is
    // identical to a run with no midnight crossing at all.
    vi.useFakeTimers()

    vi.setSystemTime(new Date('2026-03-14T23:59:59.500Z'))
    await freshlyMigratedWithBills()
    const baseMsStraddled = Date.now() // captured before runDemoReset, per the fix
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
    vi.setSystemTime(new Date('2026-03-15T00:00:00.500Z')) // dump happens just after midnight
    const straddled = await dumpResetState(baseMsStraddled, vi.getRealSystemTime())

    vi.setSystemTime(new Date('2026-03-14T23:59:59.500Z')) // no midnight crossing at all
    await freshlyMigratedWithBills()
    const baseMsClean = Date.now()
    await runDemoReset(env.DB, DEMO_SEEDS['nj-county-clerks'])
    const clean = await dumpResetState(baseMsClean, vi.getRealSystemTime())

    expect(straddled).toBe(clean)
  })
})

// What the snapshot gave up when calendar_events.date stopped being bucketed.
//
// This is strictly stronger than the bucket was: it recomputes the expected date
// from the seed's own offsetDays for whatever date the run happens to fall on, so
// it pins the seed's declared offset AND demoReset's snapping arithmetic, and it
// is stable across run dates because it recomputes rather than remembering.
describe('demo reset calendar dates', () => {
  const seed = DEMO_SEEDS['nj-county-clerks']

  it('writes the date the seed asks for, snapped off the weekend', async () => {
    await freshlyMigratedWithBills()
    const nowMs = Date.now()
    await runDemoReset(env.DB, seed)

    const { results } = await env.DB.prepare('SELECT id, date, source FROM calendar_events').all()
    const rows = results as Array<{ id: string; date: string; source: string }>
    expect(rows.length).toBe(seed.calendarEvents.length)

    const bySeedId = new Map(seed.calendarEvents.map(e => [e.id, e]))
    for (const r of rows) {
      const e = bySeedId.get(r.id)
      expect(e, `no seed row for calendar_events.id ${r.id}`).toBeDefined()
      // Allow a one-day slack against a UTC-midnight straddle between the nowMs
      // read above and the reset's own Date.now(): recompute for both.
      const expected = new Set([
        dateFromNow(e!.offsetDays, nowMs),
        dateFromNow(e!.offsetDays, nowMs + 86400_000),
      ])
      expect([...expected], `${r.id} (offsetDays ${e!.offsetDays})`).toContain(r.date)
    }
  })

  it('never schedules anything at the weekend', async () => {
    await freshlyMigratedWithBills()
    await runDemoReset(env.DB, seed)
    const { results } = await env.DB.prepare('SELECT id, date FROM calendar_events').all()
    for (const r of results as Array<{ id: string; date: string }>) {
      const day = new Date(r.date + 'T00:00:00Z').getUTCDay()
      expect(day, `${r.id} on ${r.date} is a weekend day`).not.toBe(0)
      expect(day, `${r.id} on ${r.date} is a weekend day`).not.toBe(6)
    }
  })

  it('keeps a past event in the past and an upcoming one upcoming', async () => {
    const todayUtc = new Date().toISOString().slice(0, 10)
    for (const e of seed.calendarEvents) {
      const d = dateFromNow(e.offsetDays)
      if (e.offsetDays < 0) expect(d < todayUtc, `${e.id} should stay past`).toBe(true)
      if (e.offsetDays > 2) expect(d > todayUtc, `${e.id} should stay upcoming`).toBe(true)
    }
  })
})
