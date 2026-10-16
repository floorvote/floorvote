import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0102 gives the group key index the columns the common list filters read
// (#379), so counting a filtered list by group reads that one small index and
// no table rows. It runs over an instance whose bills may already be grouped.
describe('migration 0102: the group key index carries the filter columns', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0102_group_key_filter_columns' })
    // Grouped bills as 0100 leaves them: raw SQL, the index not yet widened.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
        INSERT INTO bills (id, bill_number, title, state, status, session, year_start, group_key)
        SELECT 'bill' || printf('%04d', i), 'HB' || i, 't', CASE i % 2 WHEN 0 THEN 'NJ' ELSE 'TX' END,
          CASE i % 4 WHEN 0 THEN 'Passed' ELSE 'Introduced' END, 's', 2026,
          CASE WHEN i <= 800 THEN 'bill' || printf('%04d', ((i - 1) / 2) * 2 + 1) END FROM n`),
    ])
    await applyMigrations()
  })

  it('keeps the index by its name, partial to grouped bills, and leads it with the group key', async () => {
    const { results } = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_bills_group_key'").all<{ sql: string }>()
    expect(results).toHaveLength(1)
    expect(results[0].sql).toMatch(/ON bills\(group_key, /)
    expect(results[0].sql).toMatch(/WHERE group_key IS NOT NULL/)
  })

  it('carries the status, stage, state, session, year, relevance, and id columns', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM pragma_index_info('idx_bills_group_key') ORDER BY seqno").all<{ name: string }>()
    expect(results.map(r => r.name)).toEqual(['group_key', 'status', 'status_stage', 'state', 'session', 'year_start', 'relevance_score', 'id'])
  })

  it('indexes the bills already grouped when it runs', async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bills INDEXED BY idx_bills_group_key WHERE group_key IS NOT NULL").first<{ n: number }>()
    expect(row?.n).toBe(800)
  })

  it('counts the grouped bills of a filter from the index alone', async () => {
    // The statement the list's total runs for the grouped bills that meet a status filter.
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS bills FROM
      (SELECT COUNT(*) AS n FROM bills m WHERE m.group_key IS NOT NULL AND "m"."status" = ? AND "m"."state" = ? GROUP BY m.group_key)`)
      .bind('Passed', 'NJ').all<{ detail: string }>()
    const plan = results.map(r => r.detail).join('\n')
    expect(plan, plan).toContain('COVERING INDEX idx_bills_group_key')
  })

  it('analyzes the index so the planner has its statistics', async () => {
    const row = await env.DB.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_bills_group_key'").first<{ stat: string }>()
    expect(row?.stat).toBeTruthy()
  })
})
