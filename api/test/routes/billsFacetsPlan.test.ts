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
      // Two subjects a bill, of 60 names a state, so each (state, name) holds about 300 of the 60,000 rows.
      env.DB.prepare(`INSERT INTO bill_subjects (bill_id, subject_name, state)
        SELECT id, 'Subject ' || ((substr(id, 5) + 0) % 60), state FROM bills`),
      env.DB.prepare(`INSERT INTO bill_subjects (bill_id, subject_name, state)
        SELECT id, 'Subject ' || ((substr(id, 5) + 30) % 60 + 60), state FROM bills`),
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
  // Each names the committee it counts; the committee filter's own subquery of bill ids names none.
  const COMMITTEE_ROWS = /bc\.committee_id AS (v0|id)\b/
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

  it('counts every committee from the committee index alone when nothing narrows the facet, never reaching a bill', async () => {
    // A committee row always has its bill (ON DELETE CASCADE), so with nothing to test of a bill the whole count of
    // the any scope reads idx_bill_committees_committee end to end, which covers it, and no bill. Picking a committee
    // leaves its own facet unnarrowed, so it reads alike.
    for (const qs of ['', 'committee=c1']) {
      const { whole } = await committeePlans(qs)
      const msg = `"${qs}"\n${whole.sql}\n${whole.plan}`
      expect(whole.sql, msg).not.toMatch(/\bbills\b/)
      expect(whole.plan, msg).toMatch(/SCAN bc USING COVERING INDEX idx_bill_committees_committee/)
    }
  })

  it('reads every committee row once, and no worse, for the current-scope count and the info when nothing narrows them', async () => {
    // No index holds is_current, and the info names each committee, so these read every bill_committees row once:
    // the count the rows alone, the info with a bill lookup per row. Pinned as they are, so a plan that gets worse
    // (a temp B-tree, a second scan) fails.
    for (const [qs, which] of [['', 'info'], ['committeeScope=current', 'whole'], ['committeeScope=current', 'info']] as const) {
      const p = (await committeePlans(qs))[which]
      const lines = p.plan.split('\n')
      const msg = `"${qs}" ${which}\n${p.sql}\n${p.plan}`
      expect(lines[0], msg).toMatch(/^SCAN bc\b/)
      expect(lines.filter(l => /^SCAN\b/.test(l)), msg).toHaveLength(1)
      expect(p.plan, msg).not.toMatch(/TEMP B-TREE/)
      if (which === 'whole') expect(p.sql, msg).not.toMatch(/\bbills\b/)
      else expect(p.plan, msg).toMatch(/SEARCH m USING COVERING INDEX sqlite_autoindex_bills_1 \(id=\?\)/)
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

  // The subject facet's statements: the whole count of each (state, subject), and the count of its grouped bills'
  // groups. A subject filter's own EXISTS names bill_subjects too, so they are found by the values they count.
  async function subjectPlans(qs = ''): Promise<{ whole: Planned; grouped: Planned }> {
    const found = select(await facetPlans(qs), /bs\.subject_name AS v1/)
    const grouped = found.filter(p => /GROUP BY "m"\."group_key"/.test(p.sql))
    const whole = found.filter(p => !/GROUP BY "m"\."group_key"/.test(p.sql))
    expect([whole.length, grouped.length], `subject statements for "${qs}": ${found.map(p => p.sql).join(' | ')}`).toEqual([1, 1])
    return { whole: whole[0], grouped: grouped[0] }
  }

  it('counts every subject from the subject index alone when nothing narrows the facet, never reaching a bill', async () => {
    // A subject row always has its bill (ON DELETE CASCADE), so with nothing to test of a bill the whole count needs
    // none. Reaching each row's bill by key cost a lookup a row: on an instance with 170,000 subject rows that took
    // 1.5 to 3 seconds, and a few page loads spent the database's budget so that every query failed (D1 7429).
    // Picking a subject leaves its own facet unnarrowed, so it reads alike.
    for (const qs of ['', 'subject=NJ:Subject%201']) {
      const { whole } = await subjectPlans(qs)
      const msg = `"${qs}"\n${whole.sql}\n${whole.plan}`
      expect(whole.sql, msg).not.toMatch(/\bbills\b/)
      expect(whole.plan, msg).toMatch(/SCAN bs USING COVERING INDEX idx_bill_subjects_name/)
    }
  })

  it('starts from the bills a bill-column filter narrows to and reaches their subjects by key', async () => {
    for (const [qs, index] of [['status=Passed', 'idx_bills_status'], ['state=NJ', 'idx_bills_state']]) {
      const { whole } = await subjectPlans(qs)
      const msg = `"${qs}"\n${whole.sql}\n${whole.plan}`
      expect(whole.plan, msg).toContain(`SEARCH m USING INDEX ${index}`)
      expect(whole.plan, msg).toMatch(/SEARCH bs USING (COVERING )?INDEX sqlite_autoindex_bill_subjects_1 \(bill_id=\?\)/)
      expect(whole.plan, msg).not.toMatch(/SCAN (bs|m)\b/)
    }
  })

  it('starts the subject and committee counts from the bills whenever a filter tests them, never from every row', async () => {
    // Left to choose under a tag filter or a search, the planner read every subject row and looked its bill up by
    // key: on an instance of 100,000 bills and 170,000 subject rows, 1.4 s and 340,000 rows read for the subject
    // facet, where starting from the few bills the tag names cost 77 ms and 40,000. So the join is written from the
    // bills (CROSS JOIN fixes the order), and whatever narrows them starts every count and the committee names.
    for (const qs of ['tag=Energy', 'search=Title%2012', 'tag=Energy&committeeScope=current']) {
      const { whole, grouped } = await subjectPlans(qs)
      const committee = await committeePlans(qs)
      for (const p of [whole, grouped, committee.whole, committee.grouped, committee.info]) {
        const msg = `"${qs}"\n${p.sql}\n${p.plan}`
        expect(p.plan, msg).toMatch(/SEARCH b[sc] USING (COVERING )?INDEX sqlite_autoindex_bill_(subjects|committees)_1 \(bill_id=\?\)/)
        expect(p.plan, msg).not.toMatch(/SCAN b[sc]\b/)
      }
    }
  })

  it('reads the bills a search matches once, and counts every facet from their ids by key', async () => {
    // A search has no index to start from: each of its LIKEs reads every bill, about 0.4 s a statement on an instance
    // of 100,000 bills, and a facets request ran some fifteen of them, so one search spent the database's budget and
    // every query failed (D1 7429). The facets now read the matching ids once (LIKE, one scan) and give every count
    // the ids as one JSON parameter, so each starts from the primary key (about 13 ms a thousand ids).
    const stmts = await statementsFor('search=Title%2012')
    const likes = stmts.filter(s => /\blike\b/i.test(s.sql))
    expect(likes.map(s => s.sql), 'one read of the matching ids, and no count with a LIKE').toHaveLength(1)
    expect(likes[0].sql).toMatch(/^select "id" from "bills"/i)
    const counts = await facetPlans('search=Title%2012')
    expect(counts.length).toBeGreaterThan(10)
    for (const p of counts) {
      const msg = `${p.sql}\n${p.plan}`
      expect(p.sql, msg).toMatch(/json_each/)
      // The grouped bills are still read in group key order (countBy); every other read of the bills is by key.
      expect(p.plan, msg).not.toMatch(/SCAN (bills|m|me|g|fb)\b(?! USING COVERING INDEX idx_bills_group_key)/)
    }
  })

  it('counts the groups of each subject from the group key index, its rows reached by key', async () => {
    for (const qs of ['', 'status=Passed', 'subject=NJ:Subject%201']) {
      const { grouped } = await subjectPlans(qs)
      const msg = `"${qs}"\n${grouped.sql}\n${grouped.plan}`
      expect(grouped.plan, msg).toMatch(/SEARCH m USING COVERING INDEX idx_bills_group_key \(group_key>\?\)/)
      expect(grouped.plan, msg).toMatch(/SEARCH bs USING (COVERING )?INDEX sqlite_autoindex_bill_subjects_1 \(bill_id=\?\)/)
      expect(grouped.plan, msg).not.toMatch(/SCAN (bs|m)\b/)
    }
  })

  it('starts every count under a picked subject or committee from that pick\'s rows, never walking the bills', async () => {
    // Written as a test on each bill (EXISTS), a picked subject walked every bill and probed its subjects: about 1 s
    // and 300,000 rows read a statement on an instance of 100,000 bills, some 40 statements a facets request, so one
    // pick spent the database's budget and every query failed (D1 7429). Started from the pick's rows by the subject or
    // committee index, each bill reached by key, it read a few hundred rows in a few milliseconds.
    const cases: [string, RegExp, RegExp][] = [
      ['subject=NJ:Subject%201', /subject_name\) IN/, /SEARCH bs USING (COVERING )?INDEX idx_bill_subjects_name \(state=\? AND subject_name=\?\)/],
      ['subject=NJ:Subject%201&subject=TX:Subject%202', /subject_name\) IN/, /SEARCH bs USING (COVERING )?INDEX idx_bill_subjects_name \(state=\? AND subject_name=\?\)/],
      ['committee=c1', /committee_id IN \(SELECT value FROM json_each/, /SEARCH bc USING (COVERING )?INDEX idx_bill_committees_committee \(committee_id=\?\)/],
      ['committee=c1&committeeScope=current', /committee_id IN \(SELECT value FROM json_each/, /SEARCH bc USING (COVERING )?INDEX idx_bill_committees_committee \(committee_id=\?\)/],
    ]
    for (const [qs, filterSql, pickIndex] of cases) {
      const filtered = (await facetPlans(qs)).filter(p => filterSql.test(p.sql))
      expect(filtered.length, qs).toBeGreaterThan(0)
      for (const p of filtered) {
        const msg = `"${qs}"\n${p.sql}\n${p.plan}`
        expect(p.plan, msg).toMatch(pickIndex)
        expect(p.plan, msg).not.toMatch(/SCAN (m|me|bills)\b/)
      }
    }
  })

  // The facets index (0124) holds every column a bill fact reads, so the subject and committee counts start from the
  // bills that meet a filter and read them from the index alone, whichever column the filter tests (#1019). Before it,
  // a filter on a column with no index of its own (the priority holder, a position, the unvoted scope) or one the
  // planner misjudged (a tag with match=any) read every bill row.
  const FACTS_INDEX_REQUESTS = ['year=2025', 'priority=none', 'position=none', 'unvoted=1', 'tag=Energy&status=Passed&state=NJ&match=any']

  it('reads the bills under the subject and committee counts from the facets index alone, then their rows by key', async () => {
    for (const qs of FACTS_INDEX_REQUESTS) {
      const subject = await subjectPlans(qs)
      const committee = await committeePlans(qs)
      for (const [name, p] of [['subject', subject.whole], ['committee', committee.whole], ['committee names', committee.info]] as const) {
        const msg = `${name} under "${qs}"\n${p.sql}\n${p.plan}`
        expect(p.plan, msg).toMatch(/(SCAN|SEARCH) m USING COVERING INDEX idx_bills_facets/)
        expect(p.plan, msg).toMatch(/SEARCH b[sc] USING (COVERING )?INDEX sqlite_autoindex_bill_(subjects|committees)_1 \(bill_id=\?\)/)
        expect(p.plan, msg).not.toMatch(TABLE_SCAN)
      }
    }
  })

  it('reads no bill row but through a covering index or by its key in any count, for each filter alone and in pairs under both operators', async () => {
    const requests = [
      'year=2025', 'priority=none', 'priority=high', 'priority=__any__', 'position=none', 'position=Support', 'unvoted=1', 'myBills=1', 'newMatches=1', 'drafts=1',
      'minRelevance=7', 'tag=Energy', 'status=Passed', 'state=NJ', 'sessionName=s1', 'stage=passed',
      'priority=none&state=NJ', 'priority=high&position=none', 'year=2025&status=Passed', 'tag=Energy&priority=none',
      'priority=none&state=NJ&match=any', 'position=none&year=2025&match=any', 'tag=Energy&status=Passed&state=NJ&match=any', 'unvoted=1&status=Passed&match=any',
    ]
    for (const qs of requests) {
      for (const p of await facetPlans(`${qs}&omit=subject%2Ccommittee`)) {
        // An index of the bills that holds only some of them (the partial ones), or one that is read apart from
        // its table, is fine; a plain read of the rows is not, nor is an index of one column plus the table.
        for (const line of p.plan.split('\n')) {
          if (/(SCAN|SEARCH) (m|me|fb|g|h|bills) USING INDEX (?!idx_bills_(group_tags|group_key|drafts|prioritized|tracked)\b)/.test(line)) {
            // A lookup by key, or by the group key, is how a grouped bill's companions are reached.
            if (/sqlite_autoindex_bills_1 \(id=\?\)|\(group_key=\?\)/.test(line)) continue
            expect.unreachable(`"${qs}": ${line}\n${p.sql}\n${p.plan}`)
          }
        }
        expect(p.plan, `"${qs}"\n${p.sql}\n${p.plan}`).not.toMatch(TABLE_SCAN)
      }
    }
  })

  it('counts the priority and position holders, and the whole counts of priority none, without an index of the priority column alone', async () => {
    for (const qs of ['', 'priority=none', 'position=none', 'state=NJ', 'priority=none&state=NJ', 'priority=none&match=any']) {
      for (const p of await facetPlans(`${qs}&omit=subject%2Ccommittee`)) {
        expect(p.plan, `"${qs}"\n${p.sql}\n${p.plan}`).not.toMatch(/SEARCH m USING INDEX idx_bills_priority\b/)
      }
    }
  })

  it('writes the none of a priority as a test no index can serve, so the facets index is read end to end', async () => {
    // 99% of bills have no priority, so idx_bills_priority (one column) plus a table lookup a row loses to reading
    // the covering facets index whole. `+priority` keeps the planner off it.
    const all = await facetPlans('priority=none&omit=subject%2Ccommittee')
    const bare = all.filter(p => /(?<!\+)"m"\."priority" IS NULL/.test(p.sql))
    expect(bare.map(p => p.sql), 'a count tests the bare priority IS NULL').toHaveLength(0)
    const plain = all.filter(p => /\+"m"\."priority" IS NULL/.test(p.sql))
    expect(plain.length, 'no count carried the non-indexable none test').toBeGreaterThan(0)
  })

  it('probes the same way when the filters narrow the facets, since hasDrafts ignores them', async () => {
    const probe = await draftsProbe('status=Passed&priority=high&drafts=1')
    expect(probe.plan, `${probe.sql}\n${probe.plan}`).toMatch(/idx_bills_drafts/)
  })
})
