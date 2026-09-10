import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0068 adds a partial index so healStalledAiBills() and countStalledAiBills()
// (api/src/lib/healStalledAi.ts) stop full-scanning bills every hour on every
// tenant. A behavior test can't catch a regression here — dropping the index,
// or editing one of those queries so its WHERE no longer implies the index's
// WHERE, changes nothing about the result set, only the plan. This test reads
// the actual plan SQLite picks so a later refactor that silently reintroduces
// the scan fails here instead of quietly costing every tenant a full table
// scan an hour, as documented in the migration.
describe('idx_bills_ai_stalled query plan', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('uses the partial index, not a table scan, for the heal row-selection query', async () => {
    // Mirrors healStalledAiBills()'s row-selection query: same predicate and
    // the same ORDER BY the index needs to also satisfy without a temp B-tree.
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT id, external_id FROM bills
       WHERE ai_attempted_at IS NOT NULL
         AND ai_processed_at IS NULL
         AND ai_skip_reason IS NULL
         AND ai_attempted_at < ?
         AND ai_heal_attempts < ?
       ORDER BY ai_attempted_at
       LIMIT 50`,
    ).bind('2026-01-01 00:00:00', 5).all<{ detail: string }>()

    const plan = results.map((r) => r.detail).join('\n')

    expect(
      plan.includes('idx_bills_ai_stalled'),
      `expected the plan to use idx_bills_ai_stalled but got:\n${plan}\n` +
        'If this fails, either the index was dropped or a query predicate no ' +
        "longer implies the index's partial WHERE — both silently bring back " +
        'the full table scan + sort that this migration exists to remove, at ' +
        'hourly, per-tenant cost. See api/migrations/0068_bills_ai_stalled_index.sql.',
    ).toBe(true)
    expect(
      plan.includes('SCAN'),
      `expected no table scan in the plan but got:\n${plan}`,
    ).toBe(false)
  })
})
