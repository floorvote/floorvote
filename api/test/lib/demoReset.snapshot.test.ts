import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'

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

// Timestamps are now-relative, so they differ run to run. Normalize any value
// that looks like a datetime while keeping the column present, so a dropped or
// renamed column is still caught. Date-only values ('2026-11-01' custom-field
// values, calendar_events.date offsets) are left intact — they are seed data.
const normalize = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(v)) return '<ts>'
  // A JSON config blob can embed an ISO instant (association_config.sessions
  // carries cachedAt), which would otherwise churn on every run.
  return v.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ts>')
}

/** Stable, human-diffable dump of everything the reset produced. */
export async function dumpResetState(): Promise<string> {
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
        Object.entries(r).map(([k, v]) => [k, normalize(v)]),
      )))
      .sort()
    out.push(`### ${t} (${rows.length})`, ...rows)
  }
  return out.join('\n')
}

describe('demo reset golden snapshot', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    // Seed every bill the NJ seed references so bill-linked rows actually land;
    // without bills the INSERT ... SELECT guards no-op and the snapshot is empty
    // for the tables that matter most.
    for (const [i, extId] of NJ_BILL_EXTERNAL_IDS.entries()) {
      await seedBill({ id: `bill-${extId}`, externalId: extId, billNumber: `A${1000 + i}`, title: `Bill ${i}`, state: 'NJ', priority: 'high' })
    }
  })

  it('matches the recorded snapshot', async () => {
    await runDemoReset(env.DB)
    expect(await dumpResetState()).toMatchSnapshot()
  })
})
