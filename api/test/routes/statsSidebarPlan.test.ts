import { describe, it, expect, vi, beforeAll } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession } from '../helpers'

// The sidebar loads on every page. Its statements read the prioritized bills, a few dozen on any instance, so they
// must start from the prioritized bills and never read every bill. On an instance of about 100,000 bills two of them
// scanned the table (about 225 and 380 ms), because idx_bills_priority holds the NULLs too and its statistics say a
// priority is shared by a quarter of all bills. With the subject facet, that spent D1's per-database budget within a
// few page loads, and every query in the window failed (7429). Like billsFacetsPlan.test.ts, this reads the plans of
// the SQL the route prepares, on statistics like such an instance's.

type Stmt = { sql: string; params: unknown[] }

describe('GET /stats/sidebar query plans', () => {
  let cookie: string

  async function statementsFor(path: string): Promise<Stmt[]> {
    const seen: Stmt[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql)
      const realBind = stmt.bind.bind(stmt)
      stmt.bind = ((...args: unknown[]) => { seen.push({ sql, params: args }); return realBind(...args) }) as typeof stmt.bind
      return stmt
    })
    const res = await SELF.fetch(`https://x${path}`, { headers: { Cookie: cookie } })
    spy.mockRestore()
    expect(res.status).toBe(200)
    return seen
  }
  async function plan(stmt: Stmt): Promise<string> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).bind(...stmt.params).all<{ detail: string }>()
    return results.map(r => r.detail).join('\n')
  }

  beforeAll(async () => {
    await clearDb()
    const userId = await seedUser({ role: 'member' })
    cookie = `session=${await seedSession(userId)}`
    // 30,000 bills, 30 of them prioritized across the three levels, a quarter in companion groups, and the member's
    // vote on a few of the prioritized ones.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
        INSERT INTO bills (id, bill_number, title, state, status, status_rank, status_stage, session, year_start, year_end, priority, priority_set_at, group_key)
        SELECT 'bill' || printf('%05d', i), 'HB ' || i, 'Title ' || i, CASE i % 3 WHEN 0 THEN 'UT' WHEN 1 THEN 'NJ' ELSE 'TX' END,
          'Introduced', 100, 'introduced', 's' || (i % 4), 2025, 2026,
          CASE WHEN i % 1000 = 0 THEN CASE (i / 1000) % 3 WHEN 0 THEN 'high' WHEN 1 THEN 'medium' ELSE 'low' END END,
          CASE WHEN i % 1000 = 0 THEN '2026-10-01 10:00:00' END,
          CASE WHEN i <= 7500 THEN 'bill' || printf('%05d', ((i - 1) / 2) * 2 + 1) END FROM n`),
      env.DB.prepare(`INSERT INTO member_votes (bill_id, user_id, position) SELECT id, ?, 'support' FROM bills WHERE priority IS NOT NULL AND substr(id, 5) % 3000 = 0`).bind(userId),
      env.DB.prepare('ANALYZE'),
    ])
  })

  it('reads the prioritized bills from an index, never by scanning every bill', async () => {
    const prioritized = (await statementsFor('/api/stats/sidebar')).filter(s => /"bills"\."priority" is not null/i.test(s.sql))
    // The count, the unvoted count, and the list.
    expect(prioritized.length, prioritized.map(s => s.sql).join('\n')).toBeGreaterThanOrEqual(3)
    for (const s of prioritized) {
      const p = await plan(s)
      expect(p, `${s.sql}\n${p}`).not.toMatch(/^SCAN bills\b(?! USING)/m)
      expect(p.split('\n')[0], `${s.sql}\n${p}`).toMatch(/^(SCAN|SEARCH) bills USING (COVERING )?INDEX idx_bills_prioritized\b/)
    }
  })

  it('counts and lists the prioritized bills as before', async () => {
    const res = await SELF.fetch('https://x/api/stats/sidebar', { headers: { Cookie: cookie } })
    const body = await res.json() as { priorityBillCount: number; unvotedPriorityCount: number; priorityBills: { priority: string; myVote: string | null }[] }
    expect(body.priorityBillCount).toBe(30)
    // The member voted on every third prioritized bill (3000, 6000, ... 30000): ten of the thirty.
    expect(body.unvotedPriorityCount).toBe(20)
    expect(body.priorityBills.map(b => b.priority)).toEqual([...Array(10).fill('high'), ...Array(10).fill('medium'), ...Array(10).fill('low')])
    expect(body.priorityBills.filter(b => b.myVote === 'support')).toHaveLength(10)
  })
})
