import { describe, it, expect, vi, beforeAll } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession } from '../helpers'

// Performance of the tag filter in a grouped bill list (#537). Since one row
// per group (#379), a tag filter must read each grouped bill's current group
// analysis, which made it the slowest common filter. Each bill now stores its
// group tags (migration 0103), so the filter and the tag facets test one
// column, and start from the few bills that have tags through their own
// index, not from every bill. Like billsListPlan.test.ts, this reads the plans
// of the SQL the routes really prepare, on statistics like a large instance's.

type Stmt = { sql: string; params: unknown[] }
type Planned = { sql: string; plan: string }

describe('tag filter query plans', () => {
  let cookie: string

  async function plansFor(path: string): Promise<Planned[]> {
    const seen: Stmt[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql)
      const realBind = stmt.bind.bind(stmt)
      stmt.bind = ((...args: unknown[]) => { seen.push({ sql, params: args }); return realBind(...args) }) as typeof stmt.bind
      return stmt
    })
    const res = await SELF.fetch(`https://x/api/${path}`, { headers: { Cookie: cookie } })
    spy.mockRestore()
    expect(res.status).toBe(200)
    const out: Planned[] = []
    for (const s of seen) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...s.params).all<{ detail: string }>()
      out.push({ sql: s.sql, plan: results.map(r => r.detail).join('\n') })
    }
    return out
  }
  // A full read of a table, not of an index.
  const TABLE_SCAN = /SCAN (bills|c|m|me|k|h)\b(?! USING)/
  const readsGroupTags = (p: Planned) => /group_tags/.test(p.sql)

  beforeAll(async () => {
    await clearDb()
    const userId = await seedUser({ role: 'admin' })
    cookie = `session=${await seedSession(userId)}`
    // 30,000 bills, of which i % 40 = 0 are analyzed with tags (750) and i % 30 = 0 are tracked. Bills 1 to
    // 7,500 are grouped in pairs, so a quarter of all bills are in a group. Statuses and states vary.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
        INSERT INTO bills (id, bill_number, title, state, status, status_rank, status_stage, session, year_start, year_end, tags, tenant_summary, ai_processed_at, match_type, last_action_date, group_key)
        SELECT 'bill' || printf('%05d', i), 'HB ' || i, 'Title ' || i, CASE i % 3 WHEN 0 THEN 'UT' WHEN 1 THEN 'NJ' ELSE 'TX' END,
          CASE i % 5 WHEN 0 THEN 'Passed' ELSE 'Introduced' END, CASE i % 5 WHEN 0 THEN 300 ELSE 100 END, CASE i % 5 WHEN 0 THEN 'passed' ELSE 'introduced' END,
          's' || (i % 4), 2023 + (i % 4), 2024 + (i % 4),
          CASE WHEN i % 40 = 0 THEN '["Energy"]' ELSE '[]' END, CASE WHEN i % 40 = 0 THEN 'x' END, CASE WHEN i % 40 = 0 THEN '2026-09-01 00:00:00' END,
          CASE WHEN i % 30 = 0 THEN 'keyword' END, '2026-0' || (1 + i % 9) || '-15',
          CASE WHEN i <= 7500 THEN 'bill' || printf('%05d', ((i - 1) / 2) * 2 + 1) END FROM n`),
      env.DB.prepare('ANALYZE'),
    ])
  })

  it("counts a tag filter's groups from the bills with group tags, never probing a group for its analysis", async () => {
    const plans = await plansFor('bills?tag=Energy&pageSize=20')
    // The counts of all bills and groups meeting it. (The count of tracked bills that decides the page's path
    // starts from the tracked index, as billsListPlan.test.ts pins.)
    const counts = plans.filter(p => /^SELECT COUNT/.test(p.sql.trim()) && readsGroupTags(p) && !/match_type IS NOT NULL/.test(p.sql))
    expect(counts.length, 'the list counted no groups through their group tags').toBeGreaterThanOrEqual(2)
    for (const count of counts) {
      expect(count.plan, `${count.sql}\n${count.plan}`).toContain('idx_bills_group_tags')
      expect(count.plan, `${count.sql}\n${count.plan}`).not.toMatch(TABLE_SCAN)
      // It reads no other bill of a group to find whose analysis is current.
      expect(count.sql, count.sql).not.toMatch(/ai_processed_at/)
    }
  })

  it('counts the tag facets under a broad filter from that filter, with no list of the bills meeting it', async () => {
    const plans = await plansFor('bills/facets?status=Passed')
    const tags = plans.filter(p => /COUNT\(/i.test(p.sql) && readsGroupTags(p))
    expect(tags.length, 'the facets counted no tags through group tags').toBeGreaterThanOrEqual(2)
    for (const t of tags) {
      expect(t.plan, `${t.sql}\n${t.plan}`).not.toMatch(TABLE_SCAN)
      expect(t.plan, `${t.sql}\n${t.plan}`).not.toMatch(/MATERIALIZE q|MULTI-INDEX OR/)
    }
  })

  it('counts the tag facets with no filter from the bills with group tags alone', async () => {
    const plans = await plansFor('bills/facets')
    const tags = plans.filter(p => /COUNT\(/i.test(p.sql) && readsGroupTags(p))
    expect(tags.length, 'the facets counted no tags through group tags').toBeGreaterThanOrEqual(2)
    for (const t of tags) expect(t.plan, `${t.sql}\n${t.plan}`).toContain('idx_bills_group_tags')
  })
})
