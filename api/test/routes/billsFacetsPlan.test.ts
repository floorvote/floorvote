import { describe, it, expect, vi, beforeAll } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession } from '../helpers'

// Performance is a requirement of the group-aware facets (#380): a facet request
// has to stay at the level it had before groups, about 4 ms per indexed facet on
// the largest instance (about 52,000 bills). Like billsListPlan.test.ts, this
// reads the query plans of the SQL the route really prepares, on planner
// statistics like a large instance's: mostly untracked stubs, a quarter of
// all bills in companion groups, a handful with a priority or a position. A
// facet counts the bills it did before, from the index it used before, and
// counts the grouped bills' groups from the group key index alone.

type Stmt = { sql: string; params: unknown[] }
type Planned = { sql: string; plan: string }

describe('GET /bills/facets query plans', () => {
  let cookie: string

  async function statementsFor(qs: string): Promise<Stmt[]> {
    const seen: Stmt[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      const stmt = realPrepare(sql)
      const realBind = stmt.bind.bind(stmt)
      stmt.bind = ((...args: unknown[]) => { seen.push({ sql, params: args }); return realBind(...args) }) as typeof stmt.bind
      return stmt
    })
    const res = await SELF.fetch(`https://x/api/bills/facets?${qs}`, { headers: { Cookie: cookie } })
    spy.mockRestore()
    expect(res.status).toBe(200)
    return seen
  }
  async function plan(stmt: Stmt): Promise<string> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${stmt.sql}`).bind(...stmt.params).all<{ detail: string }>()
    return results.map(r => r.detail).join('\n')
  }
  // The facet statements: the ones that tally bills, by COUNT or by SUM (the status groups' per-bill tally), which no
  // other read of a request names. A tally by SUM once slipped past a filter on COUNT alone.
  async function facetPlans(qs = ''): Promise<Planned[]> {
    const out: Planned[] = []
    for (const s of await statementsFor(qs)) {
      if (/COUNT\(|SUM\(/i.test(s.sql)) out.push({ sql: s.sql, plan: await plan(s) })
    }
    return out
  }
  // The statement behind `statusGroups` (#677): each status label's stage and highest rank.
  const STATUS_GROUPS = /MAX\([^)]*status_rank/i
  const select = (plans: Planned[], needle: RegExp) => plans.filter(p => needle.test(p.sql))
  // A full read of a table, not of an index.
  const TABLE_SCAN = /SCAN (bills|m|me|fb|bs|p|cv|bcfv|official_positions|bc)\b(?! USING)/

  beforeAll(async () => {
    await clearDb()
    const userId = await seedUser({ role: 'admin' })
    cookie = `session=${await seedSession(userId)}`
    // 30,000 bills. i % 30 = 0 are tracked. Bills 1 to 7,500 are grouped in pairs, so a quarter of all
    // bills are in a group. A few have priorities or positions. Statuses and states vary.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000)
        INSERT INTO bills (id, bill_number, title, state, status, status_rank, status_stage, session, year_start, year_end, tags, match_type, priority, priority_set_at, relevance_score, last_action_date, group_key)
        SELECT 'bill' || printf('%05d', i), 'HB ' || i, 'Title ' || i, CASE i % 3 WHEN 0 THEN 'UT' WHEN 1 THEN 'NJ' ELSE 'TX' END,
          CASE i % 5 WHEN 0 THEN 'Passed' ELSE 'Introduced' END, CASE i % 5 WHEN 0 THEN 300 ELSE 100 END, CASE i % 5 WHEN 0 THEN 'passed' ELSE 'introduced' END,
          's' || (i % 4), 2023 + (i % 4), 2024 + (i % 4), CASE WHEN i % 30 = 0 THEN '["Energy"]' ELSE '[]' END, CASE WHEN i % 30 = 0 THEN 'keyword' END,
          CASE WHEN i % 700 = 0 THEN 'high' END, CASE WHEN i % 700 = 0 THEN '2026-10-01 10:00:00' END,
          CASE WHEN i % 30 = 0 THEN i % 10 + 1 END, '2026-0' || (1 + i % 9) || '-15',
          CASE WHEN i <= 7500 THEN 'bill' || printf('%05d', ((i - 1) / 2) * 2 + 1) END FROM n`),
      env.DB.prepare("INSERT INTO official_positions (id, bill_id, position, set_by) SELECT 'p' || id, id, 'Support', 'u' FROM bills WHERE substr(id, 5) % 1500 = 0"),
      // Two committees a bill, as central names them (#471): the one it is pending in, and one it was referred to.
      // 40 and 25 committees, so each holds a few thousand of the 60,000 rows.
      env.DB.prepare(`INSERT INTO bill_committees (bill_id, committee_id, state, name, chamber, is_current)
        SELECT id, 'c' || ((substr(id, 5) + 0) % 40), state, 'Committee ' || ((substr(id, 5) + 0) % 40), CASE WHEN (substr(id, 5) + 0) % 2 = 0 THEN 'H' ELSE 'S' END, 1 FROM bills`),
      env.DB.prepare(`INSERT INTO bill_committees (bill_id, committee_id, state, name, chamber, is_current)
        SELECT id, 'r' || ((substr(id, 5) + 0) % 25), state, 'Referral ' || ((substr(id, 5) + 0) % 25), 'S', 0 FROM bills`),
      env.DB.prepare('ANALYZE'),
      // One draft, as a tenant that has any has a few: the stats still say every bill has the same is_draft.
      env.DB.prepare("UPDATE bills SET is_draft = 1 WHERE id = 'bill00002'"),
    ])
  })

  it('counts the grouped bills of a bill-column facet from the group key index alone', async () => {
    const status = select(await facetPlans(), /m\.status|"m"\."status"/).filter(p => !STATUS_GROUPS.test(p.sql))
    expect(status.length, 'the facets prepared no status count').toBeGreaterThanOrEqual(2)
    // The statement of the grouped bills reads the covering group key index, never the table.
    const grouped = status.filter(p => /group_key/.test(p.sql) && /IS NOT NULL/.test(p.sql))
    expect(grouped.length, 'no statement counts the grouped bills of the status facet').toBeGreaterThan(0)
    for (const g of grouped) {
      expect(g.plan, `${g.sql}\n${g.plan}`).toMatch(/COVERING INDEX idx_bills_group_key/)
      expect(g.plan, `${g.sql}\n${g.plan}`).not.toMatch(TABLE_SCAN)
    }
  })

  it('reads the status groups from a covering index, so a request never reads every bill row for a rank (#677)', async () => {
    for (const qs of ['', 'state=NJ', 'status=Passed&priority=high']) {
      const groups = select(await facetPlans(qs), STATUS_GROUPS)
      expect(groups.length, `no statusGroups statement for "${qs}"`).toBe(1)
      // With nothing to narrow it the whole population is read, from the covering index. A filter may start from its own
      // index instead, which bounds the read to the bills it meets.
      if (qs === '') expect(groups[0].plan, `${groups[0].sql}\n${groups[0].plan}`).toMatch(/USING COVERING INDEX idx_bills_status_rank/)
      expect(groups[0].plan, `${groups[0].sql}\n${groups[0].plan}`).not.toMatch(TABLE_SCAN)
    }
  })

  it('keeps the whole-population count of a bill-column facet on the index it used before groups', async () => {
    const plans = await facetPlans()
    const whole = plans.find(p => /m\.status|"m"\."status"/.test(p.sql) && !/IS NOT NULL/.test(p.sql) && !STATUS_GROUPS.test(p.sql))
    expect(whole, 'no whole-population status count').toBeDefined()
    expect(whole!.plan, whole!.plan).toMatch(/SCAN m USING COVERING INDEX idx_bills_status/)
  })

  it('tests whether a bill holds its group\'s priority through the group key index', async () => {
    // Whether the planner starts the priority facet from idx_bills_priority depends on the table's size and
    // statistics (it does on the largest instance's, and on this fixture's 30,000 bills a scan is cheaper), so
    // this pins what doesn't: the three levels are named, and the rest of a bill's group is reached by its key.
    const priority = (await facetPlans()).find(p => /"me"\."priority" IN \('high', 'medium', 'low'\)/.test(p.sql))
    expect(priority, 'no priority facet').toBeDefined()
    expect(priority!.plan, priority!.plan).toContain('SEARCH g USING INDEX idx_bills_group_key (group_key=?)')
  })

  it('starts the position facet from the rows that hold the value, not from the bills', async () => {
    const plans = await facetPlans()
    const position = plans.find(p => /official_positions/.test(p.sql) && /GROUP BY/.test(p.sql))
    expect(position, 'no position facet').toBeDefined()
    expect(position!.plan, position!.plan).toMatch(/official_positions/)
    expect(position!.plan, position!.plan).not.toMatch(/SCAN (bills|me|fb)\b(?! USING)/)
  })

  it('reaches the other bills of a group only through the primary key or the group key index', async () => {
    // With a filter on, every facet tests a holder's group for a bill that meets it, as a probe of `m` by the
    // holder's id or group key.
    const probes: string[] = []
    for (const p of await facetPlans('status=Passed&priority=high')) {
      for (const line of p.plan.split('\n')) {
        if (/SEARCH m USING (COVERING )?INDEX (idx_bills_group_key \(group_key=\?|sqlite_autoindex_bills_1 \(id=\?)/.test(line)) probes.push(line)
      }
    }
    expect(probes.length, 'no facet tested a group through its bills').toBeGreaterThan(0)
  })

  it('counts the my bills, new matches, unvoted, and drafts of the current result without reading the table', async () => {
    // The statements countGroups prepares: each reads an index, never the whole table. A count held `selective`
    // when that was a guess forced a table scan on every request, since is_draft has one value in most tenants.
    const counts = (await facetPlans()).filter(p => /^SELECT COUNT\(\*\) AS (n|groups)/.test(p.sql.trim()) && / bills m\b/.test(p.sql))
    expect(counts.length, 'no special counts').toBeGreaterThanOrEqual(4)
    for (const count of counts) expect(count.plan, `${count.sql}\n${count.plan}`).not.toMatch(TABLE_SCAN)
  })

  // The probe behind `hasDrafts` (#551): does this tenant have any draft at all. It is the one statement
  // of a request that reads `bills` by is_draft alone and returns a row, not a count.
  async function draftsProbe(qs = ''): Promise<Planned> {
    const probes: Planned[] = []
    for (const s of await statementsFor(qs)) {
      if (/\bfrom "bills"/i.test(s.sql) && /is_draft/.test(s.sql) && !/COUNT\(/i.test(s.sql) && /limit/i.test(s.sql)) {
        probes.push({ sql: s.sql, plan: await plan(s) })
      }
    }
    expect(probes.length, `expected one drafts probe, saw: ${probes.map(p => p.sql).join(' | ')}`).toBe(1)
    return probes[0]
  }

  it('writes the 1 in the probe\'s SQL rather than binding it, so the partial index applies whatever the engine', async () => {
    // A statement with `is_draft = ?` can use the partial index only where the engine re-plans with the
    // bound value. The SQLite of the tests does and the plain one scans, so the SQL carries the literal.
    const probe = await draftsProbe()
    expect(probe.sql).toMatch(/"is_draft" = 1\b/)
  })

  it('probes for a draft through the partial drafts index, not a scan of the bills', async () => {
    // The tenant of this fixture has one draft in 30,000 bills, after ANALYZE.
    const probe = await draftsProbe()
    expect(probe.plan, `${probe.sql}\n${probe.plan}`).toMatch(/idx_bills_drafts/)
    expect(probe.plan, `${probe.sql}\n${probe.plan}`).not.toMatch(TABLE_SCAN)
  })

  it('probes the same way when no bill is a draft and the statistics say one value', async () => {
    // The case that scanned: with no draft, idx_bills_is_draft has a single distinct value in sqlite_stat1,
    // so the planner reads the whole table before it would read that index.
    await env.DB.batch([env.DB.prepare("UPDATE bills SET is_draft = 0 WHERE is_draft = 1"), env.DB.prepare('ANALYZE')])
    try {
      const probe = await draftsProbe()
      expect(probe.plan, `${probe.sql}\n${probe.plan}`).toMatch(/idx_bills_drafts/)
      expect(probe.plan, `${probe.sql}\n${probe.plan}`).not.toMatch(TABLE_SCAN)
    } finally {
      await env.DB.batch([env.DB.prepare("UPDATE bills SET is_draft = 1 WHERE id = 'bill00002'"), env.DB.prepare('ANALYZE')])
    }
  })

  // The committee facet's statements (#471): the whole count of each committee, the count of its grouped bills'
  // groups, and `committeeInfo`, which names each one. The info tallies by neither COUNT( nor SUM(, so facetPlans
  // does not select it, and the three are found by the rows they read.
  const COMMITTEE_ROWS = /FROM bill_committees\s+bc\s+JOIN\s+bills\s+m\b/i
  async function committeePlans(qs = ''): Promise<{ whole: Planned; grouped: Planned; info: Planned }> {
    const found: Planned[] = []
    for (const s of await statementsFor(qs)) {
      if (COMMITTEE_ROWS.test(s.sql)) found.push({ sql: s.sql, plan: await plan(s) })
    }
    const label = `committee statements for "${qs}": ${found.map(p => p.sql).join(' | ')}`
    expect(found.length, `expected three ${label}`).toBe(3)
    const info = found.filter(p => /MAX\(bc\.name\)/.test(p.sql))
    const grouped = found.filter(p => /GROUP BY "m"\."group_key"/.test(p.sql))
    const whole = found.filter(p => !/GROUP BY "m"\."group_key"/.test(p.sql) && !/MAX\(bc\.name\)/.test(p.sql))
    expect([info.length, grouped.length, whole.length], `expected one info, one grouped count, and one whole count: ${label}`).toEqual([1, 1, 1])
    return { whole: whole[0], grouped: grouped[0], info: info[0] }
  }
  // Each scope with nothing narrowing the facets, a filter on a bill column, a filter picking a committee, and a
  // priority filter (which tests a bill's whole group).
  const COMMITTEE_REQUESTS = [
    '', 'committeeScope=current', 'committee=c1', 'committee=c1&committeeScope=current', 'status=Passed', 'state=NJ&committeeScope=current',
    'status=Passed&committee=c1', 'priority=high&committeeScope=current',
  ]

  it('never reads bills or the committee rows by a table scan, in either scope or under any filter', async () => {
    for (const qs of COMMITTEE_REQUESTS) {
      const { whole, grouped, info } = await committeePlans(qs)
      for (const p of [whole, grouped, info]) expect(p.plan, `"${qs}"\n${p.sql}\n${p.plan}`).not.toMatch(TABLE_SCAN)
    }
  })

  it('counts every committee from the committee index alone when nothing narrows the facet, each bill reached by key', async () => {
    // The whole count of the any scope reads idx_bill_committees_committee end to end, which covers it, and looks
    // each row's bill up by its primary key. Picking a committee leaves its own facet unnarrowed, so it reads alike.
    for (const qs of ['', 'committee=c1']) {
      const { whole } = await committeePlans(qs)
      expect(whole.plan, `"${qs}"\n${whole.sql}\n${whole.plan}`).toMatch(/SCAN bc USING COVERING INDEX idx_bill_committees_committee/)
      expect(whole.plan, `"${qs}"\n${whole.sql}\n${whole.plan}`).toMatch(/SEARCH m USING COVERING INDEX sqlite_autoindex_bills_1 \(id=\?\)/)
    }
  })

  it('reads every committee row by index, and no worse, for the current-scope count and the info when nothing narrows them', async () => {
    // Today these read every bill_committees row by idx_bill_committees_committee (not covering: no index holds
    // is_current, and the info names each committee), a bill lookup per row. Pinned as it is, so a plan that gets worse
    // (a temp B-tree, a second scan, a table scan) fails.
    for (const [qs, which] of [['', 'info'], ['committeeScope=current', 'whole'], ['committeeScope=current', 'info']] as const) {
      const p = (await committeePlans(qs))[which]
      const lines = p.plan.split('\n')
      const msg = `"${qs}" ${which}\n${p.sql}\n${p.plan}`
      expect(lines[0], msg).toMatch(/^SCAN bc USING INDEX idx_bill_committees_committee$/)
      expect(lines.filter(l => /^SCAN\b/.test(l)), msg).toHaveLength(1)
      expect(p.plan, msg).not.toMatch(/TEMP B-TREE/)
      expect(p.plan, msg).toMatch(/SEARCH m USING COVERING INDEX sqlite_autoindex_bills_1 \(id=\?\)/)
    }
  })

  it('starts from the bills a bill-column filter narrows to and reaches their committees by key', async () => {
    // With a filter on the bills, reading every committee row would cost more as a tenant gains committees than the
    // filter's bills do: the count and the info start from the bill index, and reach the rows by (bill_id, ...).
    for (const [qs, index] of [['status=Passed', 'idx_bills_status'], ['state=NJ&committeeScope=current', 'idx_bills_state']]) {
      const { whole, info } = await committeePlans(qs)
      for (const p of [whole, info]) {
        expect(p.plan, `"${qs}"\n${p.sql}\n${p.plan}`).toContain(`SEARCH m USING INDEX ${index} `)
        expect(p.plan, `"${qs}"\n${p.sql}\n${p.plan}`).toMatch(/SEARCH bc USING (COVERING )?INDEX sqlite_autoindex_bill_committees_1 \(bill_id=\?\)/)
        expect(p.plan, `"${qs}"\n${p.sql}\n${p.plan}`).not.toMatch(/SCAN (bc|m)\b/)
      }
    }
  })

  it('counts the groups of each committee from the group key index, its rows reached by key', async () => {
    // The grouped bills read the covering group key index and each one's committee rows by (bill_id, ...), as the
    // other facets' grouped counts do, and scan neither table.
    for (const qs of ['', 'committeeScope=current', 'status=Passed', 'committee=c1&committeeScope=current']) {
      const { grouped } = await committeePlans(qs)
      expect(grouped.plan, `"${qs}"\n${grouped.sql}\n${grouped.plan}`).toMatch(/SEARCH m USING COVERING INDEX idx_bills_group_key \(group_key>\?\)/)
      expect(grouped.plan, `"${qs}"\n${grouped.sql}\n${grouped.plan}`).toMatch(/SEARCH bc USING (COVERING )?INDEX sqlite_autoindex_bill_committees_1 \(bill_id=\?\)/)
      expect(grouped.plan, `"${qs}"\n${grouped.sql}\n${grouped.plan}`).not.toMatch(/SCAN (bc|m)\b(?! USING)/)
    }
  })

  it('probes the same way when the filters narrow the facets, since hasDrafts ignores them', async () => {
    const probe = await draftsProbe('status=Passed&priority=high&drafts=1')
    expect(probe.plan, `${probe.sql}\n${probe.plan}`).toMatch(/idx_bills_drafts/)
  })
})
