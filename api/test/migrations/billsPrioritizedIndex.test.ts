import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0123 gives the sidebar's prioritized-bill statements an index that holds only the prioritized bills. It runs over an
// instance whose statistics were gathered before it (as D1 instances' are), and the planner must choose it with no
// statistics of its own, since the migration runs no ANALYZE.
describe('migration 0123: a partial index of the prioritized bills', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0123_bills_prioritized_index' })
    // 20,000 bills, 20 prioritized, raw SQL as an older database holds them, with statistics from before 0123.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
        INSERT INTO bills (id, bill_number, title, state, status, session, year_start, priority)
        SELECT 'bill' || printf('%05d', i), 'HB' || i, 't', 'NJ', 'Introduced', 's', 2026,
          CASE WHEN i % 1000 = 0 THEN CASE (i / 1000) % 3 WHEN 0 THEN 'high' WHEN 1 THEN 'medium' ELSE 'low' END END FROM n`),
      env.DB.prepare('ANALYZE'),
    ])
    await applyMigrations()
  })

  const planOf = async (sql: string): Promise<string> => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()
    return results.map(r => r.detail).join('\n')
  }

  it('creates the index, partial to prioritized bills, holding each of them', async () => {
    const { results } = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_bills_prioritized'").all<{ sql: string }>()
    expect(results[0]?.sql).toMatch(/WHERE priority IS NOT NULL/)
    const ids = (await env.DB.prepare('SELECT id FROM bills INDEXED BY idx_bills_prioritized WHERE priority IS NOT NULL ORDER BY id').all<{ id: string }>()).results
    expect(ids).toHaveLength(20)
  })

  it('starts a prioritized-bill statement that needs more than the priority from the index, not a scan', async () => {
    // The shape of the sidebar's list: a column the index does not hold, so the old full index lost to a table scan.
    const plan = await planOf('SELECT id, title FROM bills WHERE priority IS NOT NULL')
    expect(plan, plan).toMatch(/idx_bills_prioritized/)
    expect(plan, plan).not.toMatch(/^SCAN bills$/m)
  })

  it('keeps idx_bills_priority for the facet', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_bills_priority'").all<{ name: string }>()
    expect(results).toHaveLength(1)
  })
})
