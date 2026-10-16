import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0107 gives the drafts probe behind the facets' `hasDrafts` (#551) an index
// that holds only the drafts, so "does this tenant have any" reads at most one
// index entry however many bills it holds. It runs over an instance that may
// already hold drafts.
describe('migration 0107: a partial index of the draft bills', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0107_bills_drafts_index' })
    // 3,000 filed bills and 4 drafts, raw SQL as an older database holds them.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
        INSERT INTO bills (id, bill_number, title, state, status, session, year_start)
        SELECT 'bill' || printf('%04d', i), 'HB' || i, 't', 'NJ', 'Introduced', 's', 2026 FROM n`),
      env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, status, session, year_start, is_draft)
        VALUES ('draft1', 'DRAFT', 't', 'NJ', 'Drafting', 's', 2026, 1), ('draft2', 'DRAFT', 't', 'NJ', 'Drafting', 's', 2026, 1),
               ('draft3', 'DRAFT', 't', 'TX', 'Drafting', 's', 2026, 1), ('draft4', 'DRAFT', 't', 'TX', 'Drafting', 's', 2026, 1)`),
    ])
    await applyMigrations()
  })

  const planOf = async (sql: string): Promise<string> => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()
    return results.map(r => r.detail).join('\n')
  }

  it('creates the index, partial to draft bills', async () => {
    const { results } = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_bills_drafts'").all<{ sql: string }>()
    expect(results).toHaveLength(1)
    expect(results[0].sql).toMatch(/WHERE is_draft = 1/)
  })

  it('indexes the drafts already there, and only them', async () => {
    const { results } = await env.DB.prepare('SELECT id FROM bills INDEXED BY idx_bills_drafts WHERE is_draft = 1 ORDER BY id').all<{ id: string }>()
    expect(results.map(r => r.id)).toEqual(['draft1', 'draft2', 'draft3', 'draft4'])
  })

  it('keeps the whole-column index the corpus count reads', async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_bills_is_draft'").first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it('does not scan the table for the probe before any ANALYZE has run', async () => {
    // With no statistics the planner may seek either index of is_draft, and both read only the drafts.
    const plan = await planOf('SELECT id FROM bills WHERE is_draft = 1 LIMIT 1')
    expect(plan, plan).toMatch(/idx_bills_(drafts|is_draft)/)
    expect(plan, plan).not.toMatch(/SCAN bills(?! USING)/)
  })

  it('serves the probe from it after ANALYZE too', async () => {
    await env.DB.prepare('ANALYZE').run()
    const plan = await planOf('SELECT id FROM bills WHERE is_draft = 1 LIMIT 1')
    expect(plan, plan).toContain('idx_bills_drafts')
    expect(plan, plan).not.toMatch(/SCAN bills(?! USING)/)
  })

  it('forgets a draft that is filed or deleted, and takes one that is added', async () => {
    const ids = async () => (await env.DB.prepare('SELECT id FROM bills INDEXED BY idx_bills_drafts WHERE is_draft = 1 ORDER BY id').all<{ id: string }>()).results.map(r => r.id)
    await env.DB.prepare("UPDATE bills SET is_draft = 0 WHERE id = 'draft1'").run()
    await env.DB.prepare("DELETE FROM bills WHERE id = 'draft2'").run()
    expect(await ids()).toEqual(['draft3', 'draft4'])
    await env.DB.prepare("INSERT INTO bills (id, bill_number, title, state, status, session, year_start, is_draft) VALUES ('draft5', 'DRAFT', 't', 'NJ', 'Drafting', 's', 2026, 1)").run()
    expect(await ids()).toEqual(['draft3', 'draft4', 'draft5'])
  })

  it('finds no draft once the last one is gone', async () => {
    await env.DB.prepare('UPDATE bills SET is_draft = 0').run()
    await env.DB.prepare('ANALYZE').run()
    const { results } = await env.DB.prepare('SELECT id FROM bills WHERE is_draft = 1 LIMIT 1').all()
    expect(results).toHaveLength(0)
    const plan = await planOf('SELECT id FROM bills WHERE is_draft = 1 LIMIT 1')
    expect(plan, plan).toContain('idx_bills_drafts')
  })
})
