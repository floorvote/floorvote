import { describe, it, expect, vi, beforeAll } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession } from '../helpers'

// Performance is a requirement of the grouped bill list (#379): it has to stay
// at the level it had before groups, on the largest instance (about 93,000
// bills, of which about 2,900 are tracked). This reads the query plans of the
// SQL the list route really prepares, as a request, on planner statistics like
// that instance's: mostly untracked stubs, a thousand tracked bills, a quarter
// of all bills in companion groups, a handful with a priority or a position.
// The plans must keep using the indexes the old list used, and reach a
// group's other bills only through the group key index.

type Stmt = { sql: string; params: unknown[] }

describe('GET /bills query plans', () => {
  let cookie: string

  // The statements one list request prepares, in order, with their bound values.
  async function statementsFor(qs: string): Promise<Stmt[]> {
    const seen: Stmt[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql)
      const realBind = stmt.bind.bind(stmt)
      stmt.bind = ((...args: unknown[]) => { seen.push({ sql, params: args }); return realBind(...args) }) as typeof stmt.bind
      return stmt
    })
    const res = await SELF.fetch(`https://x/api/bills?${qs}`, { headers: { Cookie: cookie } })
    spy.mockRestore()
    expect(res.status).toBe(200)
    return seen
  }
  async function plan(stmt: Stmt): Promise<string> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).bind(...stmt.params).all<{ detail: string }>()
    return results.map(r => r.detail).join('\n')
  }
  type Planned = { sql: string; plan: string }
  // The statements that count the list or select its page: the ones that name a bill under an alias, which no other read of bills does.
  async function listPlans(qs: string): Promise<Planned[]> {
    const planned: Planned[] = []
    for (const s of await statementsFor(qs)) {
      if (/ bills (m|c)\b/.test(s.sql)) planned.push({ sql: s.sql, plan: await plan(s) })
    }
    return planned
  }
  function pageOf(plans: Planned[]): Planned {
    const page = plans.find(p => /ORDER BY/.test(p.sql) && /LIMIT/.test(p.sql))
    expect(page, 'the list prepared no group page statement').toBeDefined()
    return page!
  }
  const countsOf = (plans: Planned[]) => plans.filter(p => /^SELECT COUNT/.test(p.sql.trim()))
  // A full read of a table, not of an index: the plans below may scan an index in order, but never a table.
  const NO_TABLE_SCAN = /SCAN (bills|c|m|k)\b(?! USING)/

  beforeAll(async () => {
    await clearDb()
    const userId = await seedUser({ role: 'admin' })
    cookie = `session=${await seedSession(userId)}`
    // 30,000 bills. i % 30 = 0 are tracked (1,000). Bills 1 to 7,500 are grouped in pairs, so a
    // quarter of all bills are in a group. A few have priorities or positions. Statuses and states vary.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
        INSERT INTO bills (id, bill_number, title, state, status, status_rank, status_stage, session, year_start, year_end, tags, match_type, priority, priority_set_at, relevance_score, last_action_date, group_key)
        SELECT 'bill' || printf('%05d', i), 'HB ' || i, 'Title ' || i, CASE i % 3 WHEN 0 THEN 'UT' WHEN 1 THEN 'NJ' ELSE 'TX' END,
          CASE i % 5 WHEN 0 THEN 'Passed' ELSE 'Introduced' END, CASE i % 5 WHEN 0 THEN 300 ELSE 100 END, CASE i % 5 WHEN 0 THEN 'passed' ELSE 'introduced' END,
          's' || (i % 4), 2023 + (i % 4), 2024 + (i % 4), '[]', CASE WHEN i % 30 = 0 THEN 'keyword' END,
          CASE WHEN i % 700 = 0 THEN 'high' END, CASE WHEN i % 700 = 0 THEN '2026-10-01 10:00:00' END,
          CASE WHEN i % 30 = 0 THEN i % 10 + 1 END, '2026-0' || (1 + i % 9) || '-15',
          CASE WHEN i <= 7500 THEN 'bill' || printf('%05d', ((i - 1) / 2) * 2 + 1) END FROM n`),
      env.DB.prepare("INSERT INTO official_positions (id, bill_id, position, set_by) SELECT 'p' || id, id, 'Support', 'u' FROM bills WHERE substr(id, 5) % 1500 = 0"),
      env.DB.prepare('ANALYZE'),
    ])
  })

  it('serves the default list through the tracked index, reaching companions only through the group key', async () => {
    // Pages of 20 stay within the 1,000 tracked bills, so the default sort takes the tracked-first fast path.
    const page = pageOf(await listPlans('pageSize=20'))
    expect(page.plan, page.plan).toContain('SEARCH c USING INDEX idx_bills_match_type')
    expect(page.plan, page.plan).toContain('idx_bills_group_key')
    expect(page.plan, page.plan).not.toMatch(NO_TABLE_SCAN)
  })

  it('counts the groups without reading the table', async () => {
    const counts = countsOf(await listPlans('pageSize=20'))
    expect(counts.length).toBeGreaterThanOrEqual(2)
    for (const count of counts) expect(count.plan, `${count.sql}\n${count.plan}`).not.toMatch(NO_TABLE_SCAN)
    // The grouped bills are counted by group from the group key index alone.
    expect(counts.some(count => /COVERING INDEX idx_bills_group_key/.test(count.plan))).toBe(true)
  })

  it('keeps a filtered tracked-first page on the tracked index, testing a group through its key', async () => {
    const page = pageOf(await listPlans('status=Passed&pageSize=20'))
    expect(page.plan, page.plan).toMatch(/SEARCH c USING INDEX idx_bills_(match_type|tracked_cover)/)
    expect(page.plan, page.plan).toMatch(/SEARCH m USING (COVERING )?INDEX idx_bills_group_key \(group_key=\?/)
    expect(page.plan, page.plan).not.toMatch(NO_TABLE_SCAN)
  })

  it("counts the filter's tracked bills from the tracked index alone, as before groups", async () => {
    const tracked = (await listPlans('status=Passed&pageSize=20')).find(p => /WHERE m\.match_type IS NOT NULL/.test(p.sql))
    expect(tracked, 'the list prepared no count of tracked bills').toBeDefined()
    expect(tracked!.plan, tracked!.plan).toMatch(/SEARCH m USING (COVERING )?INDEX idx_bills_(match_type|tracked_cover)/)
    expect(tracked!.plan, tracked!.plan).not.toMatch(NO_TABLE_SCAN)
  })

  it('starts a filtered full-path page from the filter, as before groups', async () => {
    // Sorted by status, the list can't use the tracked-first path. The bills with no companions that meet the filter
    // come from the filter's own index, and the groups of the grouped ones from the group key index alone.
    const page = pageOf(await listPlans('status=Passed&sort=status&dir=desc&pageSize=20'))
    expect(page.plan, page.plan).toContain('SEARCH c USING INDEX idx_bills_status (status=?)')
    expect(page.plan, page.plan).toContain('COVERING INDEX idx_bills_group_key')
    expect(page.plan, page.plan).not.toMatch(NO_TABLE_SCAN)
  })

  it('starts a rare filter from the rows that hold it, not from the bills', async () => {
    // Twenty bills have a position, fewer than a page of 30, so the full path runs.
    const page = pageOf(await listPlans('position=Support&pageSize=30'))
    expect(page.plan, page.plan).toContain('official_positions')
    expect(page.plan, page.plan).not.toMatch(NO_TABLE_SCAN)
  })

  it('sorts groups in one pass over the table and a single sorter', async () => {
    // An unoptimizable sort reads every group once. The natural bill number is computed once per group, then sorted.
    const page = pageOf(await listPlans('sort=bill&dir=asc&pageSize=20'))
    expect((page.plan.match(/SCAN c\b(?! USING)/g) ?? []).length, page.plan).toBe(1)
    expect(page.plan, page.plan).toContain('MATERIALIZE k')
  })

  it("reads a page's bills and everything on them in two statements, since each costs D1 a round trip", async () => {
    // The bills (wide) and one read of positions, custom fields, votes, comments, and notes: the only statements
    // that name the page's group keys. Before, the second was seven.
    const stmts = await statementsFor('pageSize=20')
    const onPage = stmts.filter(s => /json_each\(\?\)/.test(s.sql))
    expect(onPage.length, onPage.map(s => s.sql.slice(0, 80)).join('\n')).toBe(2)
  })

  it('reads the bills of the groups on a page through the primary key and the group key, never a scan', async () => {
    const stmts = await statementsFor('pageSize=20')
    const members = stmts.find(s => /^select .* from "bills" where/i.test(s.sql) && /json_each/.test(s.sql))!
    const memberPlan = await plan(members)
    expect(memberPlan, memberPlan).toContain('sqlite_autoindex_bills_1')
    expect(memberPlan, memberPlan).toContain('idx_bills_group_key')
    expect(memberPlan, memberPlan).not.toMatch(NO_TABLE_SCAN)
  })
})
