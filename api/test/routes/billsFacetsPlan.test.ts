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
      // A team's custom field, held by a few bills, so the cube's shapes include one.
      env.DB.prepare(`INSERT INTO custom_field_definitions (id, name, slug, type, options, multiple) VALUES ('field-binary', 'Tracking', 'tracking', 'binary', NULL, 0)`),
      env.DB.prepare(`INSERT INTO bill_custom_field_values (bill_id, field_id, value, set_by) SELECT id, 'field-binary', '1', '${userId}' FROM bills WHERE substr(id, 5) % 1200 = 0`),
      // The member has voted on a few bills, so the my bills and unvoted scopes each name some.
      env.DB.prepare(`INSERT INTO member_votes (id, user_id, bill_id, position) SELECT 'v' || id, '${userId}', id, 'support' FROM bills WHERE substr(id, 5) % 2000 = 0`),
      env.DB.prepare('ANALYZE'),
      // One draft, as a tenant that has any has a few: the stats still say every bill has the same is_draft.
      env.DB.prepare("UPDATE bills SET is_draft = 1 WHERE id = 'bill00002'"),
    ])
  })

  // The bill-column facets and the status groups are sums over two cubes (#1022, below): the grouped bills' groups come
  // from the grouped cube, which reads the covering group key index, and the whole counts, the labels' stages and their
  // ranks from the whole cube, which reads the covering facets index (0124, which holds the rank).
  it('counts the grouped bills of a bill-column facet from the group key index alone', async () => {
    const grouped = select(await facetPlans(), /GROUP BY "m"\."group_key", "m"\."status"/)
    expect(grouped.length, 'no grouped cube').toBe(1)
    expect(grouped[0].plan, `${grouped[0].sql}\n${grouped[0].plan}`).toMatch(/SEARCH m USING COVERING INDEX idx_bills_group_key/)
    expect(grouped[0].plan, `${grouped[0].sql}\n${grouped[0].plan}`).not.toMatch(TABLE_SCAN)
  })

  it('reads the status groups from a covering index, so a request never reads every bill row for a rank (#677)', async () => {
    for (const qs of ['', 'state=NJ', 'status=Passed&priority=high']) {
      const groups = select(await facetPlans(qs), STATUS_GROUPS)
      // The ranks are read with the whole cube's counts, by no statement of their own.
      expect(groups.length, `no statusGroups statement for "${qs}"`).toBe(1)
      expect(groups[0].sql, groups[0].sql).toMatch(/GROUP BY "m"\."status", "m"\."status_stage", "m"\."state", "m"\."session", "m"\."year_start"$/)
      if (qs === '') expect(groups[0].plan, `${groups[0].sql}\n${groups[0].plan}`).toMatch(/SCAN m USING COVERING INDEX idx_bills_facets/)
      expect(groups[0].plan, `${groups[0].sql}\n${groups[0].plan}`).not.toMatch(TABLE_SCAN)
    }
  })

  it('reads the whole-population counts of the bill-column facets from the facets index in its own order', async () => {
    const whole = select(await facetPlans(), /GROUP BY "m"\."status", "m"\."status_stage"/).filter(p => !/group_key/.test(p.sql))
    expect(whole.length, 'no whole cube').toBe(1)
    expect(whole[0].plan, whole[0].plan).toMatch(/SCAN m USING COVERING INDEX idx_bills_facets/)
    expect(whole[0].plan, whole[0].plan).not.toMatch(/TEMP B-TREE/)
  })

  it('tests whether a bill holds its group\'s priority through the group key index', async () => {
    // Whether the planner starts the priority facet from idx_bills_priority depends on the table's size and
    // statistics (it does on the largest instance's, and on this fixture's 30,000 bills a scan is cheaper), so
    // this pins what doesn't: the three levels are named, and the rest of a bill's group is reached by its key.
    const priority = (await facetPlans()).find(p => /"me"\."priority" IN \('high', 'medium', 'low'\)/.test(p.sql))
    expect(priority, 'no priority facet').toBeDefined()
    // The index carries the companion's priority and its time (0124), so the test reads no table row.
    expect(priority!.plan, priority!.plan).toContain('SEARCH g USING COVERING INDEX idx_bills_group_key (group_key=?)')
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
    const info = found.filter(p => /MAX\(bc\.name\)/.test(p.sql))
    const grouped = found.filter(p => /GROUP BY "m"\."group_key"/.test(p.sql))
    // Under a filter most bills meet, the whole count is two statements: every row, and the rows of the bills left out (#1023).
    const wholes = found.filter(p => !/GROUP BY "m"\."group_key"/.test(p.sql) && !/MAX\(bc\.name\)/.test(p.sql))
    const whole = wholes.length === 2 ? wholes.filter(p => /\bbills m\b/.test(p.sql)) : wholes
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
    // The facets index (0124) leads with the status, so it serves a status filter, covering the bills it reads.
    for (const [qs, index] of [['status=Passed', 'idx_bills_facets'], ['state=NJ&committeeScope=current', 'idx_bills_state']]) {
      const { whole, info } = await committeePlans(qs)
      for (const p of [whole, info]) {
        expect(p.plan, `"${qs}"\n${p.sql}\n${p.plan}`).toMatch(new RegExp(`SEARCH m USING (COVERING )?INDEX ${index} `))
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
    // Under a filter most bills meet, the whole count is two statements: every row, and the rows of the bills left out (#1023).
    const wholes = found.filter(p => !/GROUP BY "m"\."group_key"/.test(p.sql))
    const whole = wholes.length === 2 ? wholes.filter(p => /\bbills m\b/.test(p.sql)) : wholes
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
    for (const [qs, index] of [['status=Passed', 'idx_bills_facets'], ['state=NJ', 'idx_bills_state']]) {
      const { whole } = await subjectPlans(qs)
      const msg = `"${qs}"\n${whole.sql}\n${whole.plan}`
      expect(whole.plan, msg).toMatch(new RegExp(`SEARCH m USING (COVERING )?INDEX ${index}`))
      expect(whole.plan, msg).toMatch(/SEARCH bs USING (COVERING )?INDEX (sqlite_autoindex_bill_subjects_1|idx_bill_subjects_bill) \(bill_id=\?\)/)
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
        expect(p.plan, msg).toMatch(/SEARCH b[sc] USING (COVERING )?INDEX (sqlite_autoindex_bill_(subjects|committees)_1|idx_bill_subjects_bill) \(bill_id=\?\)/)
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
    // (The size of the table, which a request counts to tell a broad filter from a narrow one, reads a covering index of it.)
    const counts = (await facetPlans('search=Title%2012')).filter(p => !/AS total\b/.test(p.sql))
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
      expect(grouped.plan, msg).toMatch(/SEARCH bs USING (COVERING )?INDEX (sqlite_autoindex_bill_subjects_1|idx_bill_subjects_bill) \(bill_id=\?\)/)
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
  const FACTS_INDEX_REQUESTS = ['priority=none', 'position=none', 'unvoted=1', 'tag=Energy&status=Passed&state=NJ&match=any']

  it('reads the bills under the subject and committee counts from the facets index alone, then their rows by key', async () => {
    const wrong: string[] = []
    for (const qs of FACTS_INDEX_REQUESTS) {
      const subject = await subjectPlans(qs)
      const committee = await committeePlans(qs)
      // The unvoted scope tests the id alone, which the primary key's index holds and is the narrower one to read.
      const own = qs === 'unvoted=1' ? '(idx_bills_facets|sqlite_autoindex_bills_1)' : 'idx_bills_facets'
      for (const [name, p] of [['subject', subject.whole], ['committee', committee.whole]] as const) {
        const ok = new RegExp(`(SCAN|SEARCH) m USING COVERING INDEX ${own}`).test(p.plan)
          && /SEARCH b[sc] USING (COVERING )?INDEX (sqlite_autoindex_bill_(subjects|committees)_1|idx_bill_subjects_bill) \(bill_id=\?\)/.test(p.plan)
          && !TABLE_SCAN.test(p.plan)
        if (!ok) wrong.push(`${name} under "${qs}"\n${p.sql}\n${p.plan}`)
      }
    }
    expect(wrong, wrong.join('\n\n')).toEqual([])
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

  // The five bill-column facets (status, stage, state, session, year) and the status groups come from two statements a
  // request (#1022): a whole cube grouped by the five columns over the facets index, and a grouped cube grouped by the
  // group key and the five over the group key index. The route sums each facet's marginal from them in memory. Before
  // it, each facet ran two statements of its own and the status groups a third, and under a broad filter every one of
  // them read the bills it counted from the table.
  const CUBE_COLUMNS = '"m"."status", "m"."status_stage", "m"."state", "m"."session", "m"."year_start"'
  const WHOLE_CUBE = new RegExp(`GROUP BY ${CUBE_COLUMNS.replace(/[."]/g, c => (c === '.' ? '\\.' : c))}$`)
  const GROUPED_CUBE = new RegExp(`GROUP BY "m"\\."group_key", ${CUBE_COLUMNS.replace(/[."]/g, c => (c === '.' ? '\\.' : c))}$`)
  // Any statement grouped by one of the five columns (alone, in a pair, or in the cube), however it is written.
  const GROUPED_BY_A_COLUMN = /GROUP BY [^()]*?(\bm\.|"m"\.")(status|status_stage|state|session|year_start)\b/
  // A read of `m`, the bill the counts test, in a plan.
  const READS_M = /^(SCAN|SEARCH) m\b/
  const CUBE_READ = /^(SCAN|SEARCH) m USING COVERING INDEX (idx_bills_facets|idx_bills_group_key)\b/
  // Every filter alone, the none and any values, the scopes, pairs under both operators, and match=any with three facts,
  // in two kinds. A broad filter (most bills meet it, or under match=any every bill is read for its freshness) is read
  // from the two covering indexes alone. A narrow one has an index of its own that names its few bills (a priority or a
  // position value, a tag, a pick of subjects, committees, or custom field values, the search's or the member's ids, the
  // tracked bills of new matches), and the planner starts from it and reads only those bills' rows: on a copy of the
  // largest instance that cost 0.0 to 25 ms locally against 8 to 27 ms through the facets index whole.
  const BROAD_REQUESTS = [
    '', 'status=Passed', 'stage=passed', 'state=NJ', 'sessionName=s0', 'year=2025', 'minRelevance=7',
    'priority=none', 'position=none', 'unvoted=1',
    'state=NJ&status=Passed', 'year=2025&state=NJ',
    'state=NJ&status=Passed&match=any', 'year=2025&state=NJ&match=any', 'tag=Energy&status=Passed&match=any', 'priority=high&position=Support&match=any',
    'priority=none&match=any', 'status=Passed&stage=introduced&match=any',
    'tag=Energy&status=Passed&state=NJ&match=any', 'tag=Energy&priority=high&position=Support&match=any',
    'subject=NJ:Subject%201&committee=c1&match=any', 'field.field-binary=1&state=NJ&year=2025&match=any',
  ]
  const NARROW_REQUESTS = [
    'priority=high', 'priority=__any__', 'position=Support', 'tag=Energy', 'tag=__any__', 'subject=NJ:Subject%201', 'committee=c1',
    'committee=c1&committeeScope=current', 'field.field-binary=1', 'search=Title%2012', 'myBills=1', 'newMatches=1', 'drafts=1',
    'tag=Energy&status=Passed', 'priority=high&position=Support', 'subject=NJ:Subject%201&state=NJ', 'unvoted=1&tag=Energy',
  ]
  const CUBE_REQUESTS = [...BROAD_REQUESTS, ...NARROW_REQUESTS]
  const pageLoad = (qs: string) => `${qs}${qs ? '&' : ''}omit=subject%2Ccommittee`

  it('counts the five bill-column facets and the status groups from one whole cube and one grouped cube, for every filter shape', async () => {
    const wrong: string[] = []
    for (const qs of CUBE_REQUESTS) {
      const stmts = (await statementsFor(pageLoad(qs))).map(s => s.sql.replace(/\s+/g, ' ').trim())
      const byColumn = stmts.filter(s => GROUPED_BY_A_COLUMN.test(s))
      const whole = byColumn.filter(s => WHOLE_CUBE.test(s))
      const grouped = byColumn.filter(s => GROUPED_CUBE.test(s))
      const other = byColumn.filter(s => !WHOLE_CUBE.test(s) && !GROUPED_CUBE.test(s))
      if (whole.length !== 1 || grouped.length !== 1 || other.length !== 0) {
        wrong.push(`"${qs}": ${whole.length} whole cubes, ${grouped.length} grouped cubes, and ${other.length} other statements grouped by a bill column:\n${other.join('\n')}`)
      }
    }
    expect(wrong, wrong.join('\n\n')).toEqual([])
  })

  async function cubePlans(qs: string): Promise<Planned[]> {
    return (await facetPlans(pageLoad(qs))).filter(p => {
      const flat = p.sql.replace(/\s+/g, ' ').trim()
      return WHOLE_CUBE.test(flat) || GROUPED_CUBE.test(flat)
    })
  }

  it('reads the bills of both cubes under a broad filter from the facets index and the group key index alone', async () => {
    const wrong: string[] = []
    for (const qs of BROAD_REQUESTS) {
      const cubes = await cubePlans(qs)
      if (cubes.length !== 2) { wrong.push(`"${qs}": ${cubes.length} cube statements`); continue }
      for (const c of cubes) {
        const reads = c.plan.split('\n').map(l => l.trim()).filter(l => READS_M.test(l))
        // The bill `m` is read once, through a covering index of the two, in the cube's own order; anything else (a
        // table scan, a column's own index and the table row, a temporary sort of every bill) reads what the cube avoids.
        if (reads.length !== 1 || !CUBE_READ.test(reads[0]) || /TEMP B-TREE FOR GROUP BY/.test(c.plan)) {
          wrong.push(`"${qs}"\n${c.sql}\n${c.plan}`)
        }
      }
    }
    expect(wrong, wrong.join('\n\n')).toEqual([])
  })

  it('starts both cubes under a narrow filter from the index of its own bills, never reading every bill', async () => {
    const wrong: string[] = []
    for (const qs of NARROW_REQUESTS) {
      const cubes = await cubePlans(qs)
      if (cubes.length !== 2) { wrong.push(`"${qs}": ${cubes.length} cube statements`); continue }
      for (const c of cubes) {
        const reads = c.plan.split('\n').map(l => l.trim()).filter(l => READS_M.test(l))
        // Each read of `m` is bounded: a search by a key, or a covering index, or the partial index of the bills with
        // group tags. A scan of the table or of a full index of one column, with a row lookup a bill, is not. (The rows
        // that name the narrow filter's bills, a position's or a custom field's, are a table of their own, read whole.)
        const bounded = (l: string) => /^SEARCH m USING /.test(l) || CUBE_READ.test(l) || /^SCAN m USING (COVERING )?INDEX idx_bills_group_tags\b/.test(l)
        if (reads.length === 0 || !reads.every(bounded) || /SCAN (bills|m)\b(?! USING)/.test(c.plan)) wrong.push(`"${qs}"\n${c.sql}\n${c.plan}`)
      }
    }
    expect(wrong, wrong.join('\n\n')).toEqual([])
  })

  it("takes the request's group totals from the cubes, not from counts of their own", async () => {
    // Under match=any the shift adds the current result's total, and the "none" of priority and position counts the
    // groups the facet's filter meets: both are sums over the cubes when the five facets are counted. So a request
    // under match=any prepares no more counts of the current result than the same filter under match=all, and one with
    // no team-field fact of its own counts no groups by a statement of its own.
    const countsOfGroups = (stmts: Stmt[]) => stmts.filter(s => /^SELECT COUNT\(\*\) AS groups/.test(s.sql.trim())).length
    for (const qs of ['state=NJ&status=Passed', 'priority=high&position=Support', 'tag=Energy&status=Passed&state=NJ']) {
      const all = countsOfGroups(await statementsFor(pageLoad(qs)))
      const any = countsOfGroups(await statementsFor(pageLoad(`${qs}&match=any`)))
      expect(any, `"${qs}" under match=any counts the current result again`).toBe(all)
    }
    for (const qs of ['', 'status=Passed', 'year=2025&state=NJ', 'status=Passed&state=NJ&match=any', 'priority=high&position=Support&match=any']) {
      const own = (await statementsFor(pageLoad(qs))).filter(s => /GROUP BY "m"\."group_key"\)/.test(s.sql) && !/json_each\("m"\."group_tags"\)/.test(s.sql))
      expect(own.map(s => s.sql), `"${qs}" counts the groups its filter meets by a statement of its own`).toEqual([])
    }
  })

  // The menu request (`only=subject,committee`) under a broad filter (#1023). Every statement of it that counts the
  // subject and committee rows, and every probe a request prepares to choose how to, reads the bill `m` through a
  // covering index (or by its key) and the rows by key or a covering index, never through a one-column index and the
  // table row. On the largest instance (174,000 subject rows for 99,466 bills) the whole subject count alone read
  // 536,736 rows in 962 ms under `priority=none`, and the request 1.3 to 2.1 s, past the budget.
  const menu = (qs: string) => `${qs}${qs ? '&' : ''}only=subject%2Ccommittee`
  const MENU_REQUESTS = [
    'year=2025', 'status=Introduced', 'stage=introduced', 'priority=none', 'position=none', 'unvoted=1',
    'tag=Energy&priority=high&position=Support&match=any', 'tag=Energy&status=Passed&state=NJ&match=any',
  ]
  async function menuPlans(qs: string): Promise<Planned[]> {
    const out: Planned[] = []
    for (const s of await statementsFor(menu(qs))) {
      const flat = s.sql.replace(/\s+/g, ' ')
      // The counts of subject and committee rows, the committee names, and the probes that choose how to count.
      if (/bs\.subject_name AS v1|bc\.committee_id AS (v0|id)\b/.test(flat) || /AS kept\b|AS total\b/.test(flat)) out.push({ sql: flat, plan: await plan(s) })
    }
    return out
  }
  // A probe that counts the bills a filter meets reads no column but the filter's, so any covering index of them serves.
  // The committee names read each committee row's name and chamber, which no index holds, so that statement reads them whole.
  const goodRead = (line: string, probe = false, names = false): boolean => {
    const l = line.trim()
    if (names && /^SCAN bc\b/.test(l)) return true
    if (probe && /^(SCAN|SEARCH) m\b/.test(l)) return /USING COVERING INDEX/.test(l)
    if (/^(SCAN|SEARCH) m\b/.test(l)) return /USING COVERING INDEX (idx_bills_facets|idx_bills_group_key|sqlite_autoindex_bills_1)\b/.test(l)
    if (/^(SCAN|SEARCH) bs\b/.test(l)) return /USING COVERING INDEX/.test(l)
    if (/^(SCAN|SEARCH) bc\b/.test(l)) return /USING COVERING INDEX|INDEX sqlite_autoindex_bill_committees_1 \(bill_id=\?\)/.test(l)
    return true
  }

  it('reads the bills under each broad filter through the facets index, and their subject and committee rows by a covering index or key', async () => {
    const wrong: string[] = []
    for (const qs of MENU_REQUESTS) {
      const plans = await menuPlans(qs)
      if (plans.length === 0) wrong.push(`"${qs}": no statement`)
      for (const p of plans) {
        const bad = p.plan.split('\n').filter(l => !goodRead(l, /AS kept\b/.test(p.sql), /MAX\(bc\.name\)/.test(p.sql)))
        if (bad.length > 0) wrong.push(`"${qs}"\n${p.sql}\n${p.plan}`)
      }
    }
    expect(wrong, wrong.join('\n\n')).toEqual([])
  })

  it('counts a broad filter\'s subjects as the subject index less the rows of the bills it leaves out', async () => {
    // Under a filter that most bills meet (80% of this fixture's bills are Introduced) the rows kept are most of the
    // table, so counting them joins every bill to its rows. The rows of the bills left out are few, so the count is the
    // subject index end to end, which covers it, less those rows.
    const whole = (await menuPlans('status=Introduced')).filter(p => /bs\.subject_name AS v1/.test(p.sql) && !/GROUP BY "m"\."group_key"/.test(p.sql))
    expect(whole.length, whole.map(p => p.sql).join('\n')).toBe(2)
    expect(whole.some(p => /SCAN bs USING COVERING INDEX idx_bill_subjects_name/.test(p.plan) && !/\bbills\b/.test(p.sql)), 'no whole read of the subject index').toBe(true)
    // And a filter few bills meet is counted from those bills, as before.
    const narrow = (await menuPlans('status=Passed')).filter(p => /bs\.subject_name AS v1/.test(p.sql) && !/GROUP BY "m"\."group_key"/.test(p.sql))
    expect(narrow.length, narrow.map(p => p.sql).join('\n')).toBe(1)
    expect(narrow[0].plan).toMatch(/SEARCH m USING COVERING INDEX idx_bills_facets/)
  })

  it('evaluates the current result once for the subject and committee counts under match=any, not once a statement', async () => {
    // Each count tested every bill for freshness against the filter, about 0.4 s a statement on the largest instance
    // and four statements a request. The current result is read once, as its keys, and each count is given them.
    const stmts = (await statementsFor(menu('tag=Energy&priority=high&position=Support&match=any'))).map(s => s.sql)
    const evaluating = stmts.filter(sql => /json_each\("(m|cm)"\."group_tags"\)/.test(sql))
    expect(evaluating.length, evaluating.map(s => s.replace(/\s+/g, ' ').slice(0, 120)).join('\n')).toBeLessThanOrEqual(1)
  })

  // The page load under a year (#1023): its tag, drafts, and unvoted counts read the year column's index and then the
  // table, for 72% of bills, where the facets index read whole is cheaper.
  it('reads the bills under a year from the facets index, for every count of the page load', async () => {
    const wrong: string[] = []
    for (const qs of ['year=2025', 'year=2025&state=NJ', 'year=2025&match=any']) {
      for (const p of await facetPlans(pageLoad(qs))) {
        const bad = p.plan.split('\n').filter(l => /^(SCAN|SEARCH) (m|bills) USING INDEX idx_bills_year_start\b/.test(l.trim()))
        if (bad.length > 0) wrong.push(`"${qs}"\n${p.sql}\n${p.plan}`)
      }
    }
    expect(wrong, wrong.join('\n\n')).toEqual([])
  })
})
