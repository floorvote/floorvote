import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0124 gives the facet counts one covering index over every bill column they read, and widens the group key index
// with the columns the holder and tag tests read on a bill's companions. It runs over an instance that has the old
// group key index and bills already grouped, as a deployed database does.
describe('migration 0124: the covering facets index and the wider group key index', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0124_bills_facets_index' })
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
        INSERT INTO bills (id, bill_number, title, state, status, session, year_start, priority, priority_set_at, group_key)
        SELECT 'bill' || printf('%04d', i), 'HB' || i, 't', CASE i % 2 WHEN 0 THEN 'NJ' ELSE 'TX' END,
          CASE i % 4 WHEN 0 THEN 'Passed' ELSE 'Introduced' END, 's', 2026,
          CASE WHEN i % 500 = 0 THEN 'high' END, CASE WHEN i % 500 = 0 THEN '2026-10-01 10:00:00' END,
          CASE WHEN i <= 600 THEN 'bill' || printf('%04d', ((i - 1) / 2) * 2 + 1) END FROM n`),
    ])
    // The database this migration upgrades holds the old group key index.
    const { results } = await env.DB.prepare("SELECT name FROM pragma_index_info('idx_bills_group_key') ORDER BY seqno").all<{ name: string }>()
    expect(results.map(r => r.name)).toEqual(['group_key', 'status', 'status_stage', 'state', 'session', 'year_start', 'relevance_score', 'id'])
  })

  const columnsOf = async (index: string): Promise<string[]> => {
    const { results } = await env.DB.prepare(`SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`).all<{ name: string }>()
    return results.map(r => r.name)
  }

  describe('once applied', () => {
    beforeEach(async () => { await applyMigrations() })

    it('creates idx_bills_facets over the facet columns, the status leading and the id last', async () => {
      expect(await columnsOf('idx_bills_facets')).toEqual([
        'status', 'status_stage', 'state', 'session', 'year_start', 'priority', 'priority_set_at', 'relevance_score', 'match_type',
        'new_match_at', 'is_draft', 'group_key', 'group_tags', 'status_rank', 'id',
      ])
    })

    it('holds every bill in idx_bills_facets, not a part of them', async () => {
      const { results } = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_bills_facets'").all<{ sql: string }>()
      expect(results[0]?.sql).not.toMatch(/\bWHERE\b/i)
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM bills INDEXED BY idx_bills_facets').first<{ n: number }>()
      expect(row?.n).toBe(3000)
    })

    it('rebuilds idx_bills_group_key with the priority, its time, and the group tags added, still partial to grouped bills', async () => {
      expect(await columnsOf('idx_bills_group_key')).toEqual([
        'group_key', 'status', 'status_stage', 'state', 'session', 'year_start', 'relevance_score', 'priority', 'priority_set_at', 'group_tags', 'id',
      ])
      const { results } = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_bills_group_key'").all<{ sql: string }>()
      expect(results).toHaveLength(1)
      expect(results[0].sql).toMatch(/WHERE group_key IS NOT NULL/)
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM bills INDEXED BY idx_bills_group_key WHERE group_key IS NOT NULL').first<{ n: number }>()
      expect(row?.n).toBe(600)
    })

    it('keeps the single-column indexes the other readers use', async () => {
      const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bills' ORDER BY name").all<{ name: string }>()
      const names = results.map(r => r.name)
      for (const keep of ['idx_bills_status', 'idx_bills_state', 'idx_bills_session', 'idx_bills_year_start', 'idx_bills_status_stage', 'idx_bills_priority', 'idx_bills_prioritized']) {
        expect(names, keep).toContain(keep)
      }
    })

    it('analyzes both indexes so the planner has their statistics', async () => {
      for (const idx of ['idx_bills_facets', 'idx_bills_group_key']) {
        const row = await env.DB.prepare('SELECT stat FROM sqlite_stat1 WHERE idx = ?').bind(idx).first<{ stat: string }>()
        expect(row, idx).not.toBeNull()
      }
    })

    it('leaves a clean schema when the whole migration set is applied again to a fresh database', async () => {
      await resetDb()
      await applyMigrations()
      expect(await columnsOf('idx_bills_facets')).toHaveLength(15)
      expect(await columnsOf('idx_bills_group_key')).toHaveLength(11)
      const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('idx_bills_facets', 'idx_bills_group_key')").all<{ n: number }>()
      expect(results[0].n).toBe(2)
    })
  })
})
