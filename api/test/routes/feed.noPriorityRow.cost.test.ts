import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { feedEvents } from '../../src/db/schema'

// What the no-priority updates row costs a GET /feed (#919 review). The row's
// bills are resolved on every read, so its queries must start from the day's
// events (the created_at index), not from every analyzed bill and its whole
// history, and a page of rows must cost a fixed number of statements, not two
// per row. These capture the SQL the route really prepares, as
// test/migrations/feedSortIndex.test.ts does, on a database migrated as
// production's is: 0121's rebuild leaves feed_events with no statistics.

type Captured = { sql: string; binds: unknown[] }

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; statements: Captured[] }> {
  const statements: Captured[] = []
  const realPrepare = env.DB.prepare.bind(env.DB)
  const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((query: string) => {
    const entry: Captured = { sql: query, binds: [] }
    statements.push(entry)
    const stmt = realPrepare(query)
    const realBind = stmt.bind.bind(stmt)
    stmt.bind = (...args: unknown[]) => { entry.binds = args; return realBind(...args) }
    return stmt
  })
  try {
    return { result: await run(), statements }
  } finally {
    spy.mockRestore()
  }
}

const planOf = async (s: Captured) => {
  const params = (s.sql.match(/\?/g) ?? []).map(() => 'x')
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...params).all<{ detail: string }>()
  return results.map((r) => r.detail).join('\n')
}
const rowsRead = async (s: Captured) => (await env.DB.prepare(s.sql).bind(...s.binds).all()).meta.rows_read

const isFeedList = (s: Captured) => /order by datetime\(/i.test(s.sql) && /limit/i.test(s.sql)
const isFeedCount = (s: Captured) => /select count\(\*\)/i.test(s.sql) && /"feed_events"/.test(s.sql) && /no_priority_updates/.test(s.sql)
// The row's own queries after the page: its days' entries, and its chips' bills.
const isRowResolution = (s: Captured) => !isFeedList(s) && !isFeedCount(s) && (/feed_events m/.test(s.sql) || /FROM bills b WHERE b.id IN/.test(s.sql))
// The SQL as it was before the review: an inner join the planner may reorder, and a range a day wider each side.
const asBefore = (q: string) => q.replaceAll('CROSS JOIN bills mb', 'JOIN bills mb')

describe('the no-priority updates row: what a GET /feed costs', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    token = await seedSession(await seedUser({ name: 'Mia Member' }))
  })

  const getFeed = async () => {
    const res = await SELF.fetch('http://localhost/api/feed?limit=40', { headers: { Cookie: `session=${token}` } })
    expect(res.status).toBe(200)
    return await res.json() as { events: Array<{ type: string; metadata: { count?: number } }> }
  }
  const row = (day: string) =>
    getDb(env.DB).insert(feedEvents).values({ id: `row-${day}`, type: 'no_priority_updates' as never, billId: null, userId: 'system', metadata: '{}', createdAt: `${day} 06:00:00` })
  const update = (billId: string, at: string) =>
    getDb(env.DB).insert(feedEvents).values({ id: crypto.randomUUID(), type: 'bill_updated', billId, userId: 'system', metadata: '{"changes":[]}', createdAt: at })

  it('resolves the rows from the day\'s events, through the created_at index', async () => {
    await update(await seedBill({ billNumber: 'HB 1', relevanceScore: 5 }), '2026-03-04 09:00:00')
    await row('2026-03-04')

    const { result, statements } = await capture(getFeed)
    expect(result.events.map((e) => e.type)).toEqual(['no_priority_updates'])

    const resolving = statements.filter(isRowResolution)
    const list = statements.find(isFeedList)
    const count = statements.find(isFeedCount)
    expect(resolving.length, statements.map((s) => s.sql).join('\n\n')).toBeGreaterThan(0)
    expect(list).toBeDefined()
    expect(count).toBeDefined()
    expect(resolving.some((s) => /GROUP BY day/.test(s.sql))).toBe(true)
    for (const s of [...resolving.filter((x) => /feed_events m/.test(x.sql)), list!, count!]) {
      const plan = await planOf(s)
      expect(plan, `plan of:\n${s.sql}\n\n${plan}`).toContain('SEARCH m USING INDEX idx_feed_events_created')
      expect(plan, `plan of:\n${s.sql}\n\n${plan}`).not.toMatch(/SCAN m\b/)
    }
  })

  it('costs the same number of statements for three rows on the page as for one', async () => {
    const days = ['2026-03-02', '2026-03-03', '2026-03-04']
    for (const [i, day] of days.entries()) {
      for (let j = 0; j < 3; j++) await update(await seedBill({ billNumber: `HB ${i}${j}`, relevanceScore: j + 1 }), `${day} 09:0${j}:00`)
    }

    await row('2026-03-04')
    const one = await capture(getFeed)
    expect(one.result.events.filter((e) => e.type === 'no_priority_updates')).toHaveLength(1)

    await row('2026-03-02')
    await row('2026-03-03')
    const three = await capture(getFeed)
    expect(three.result.events.filter((e) => e.type === 'no_priority_updates').map((e) => e.metadata.count)).toEqual([3, 3, 3])

    expect(three.statements.length).toBe(one.statements.length)
  })

  describe('the row\'s list (GET /feed/events/:id/bills)', () => {
    const list = async (qs: string) => {
      const res = await SELF.fetch(`http://localhost/api/feed/events/row-2026-03-04/bills${qs}`, { headers: { Cookie: `session=${token}` } })
      expect(res.status).toBe(200)
      return await res.json() as { entries: unknown[] }
    }
    const seedDay = async (bills: number) => {
      for (let i = 0; i < bills; i++) await update(await seedBill({ billNumber: `HB ${i}`, relevanceScore: 1 + (i % 10) }), `2026-03-04 09:${String(i % 60).padStart(2, '0')}:00`)
      await row('2026-03-04')
    }

    it('reads the page\'s events through the created_at index', async () => {
      await seedDay(3)
      const { result, statements } = await capture(() => list('?page=1'))
      expect(result.entries).toHaveLength(3)
      const events = statements.find((x) => /SELECT m\.id, m\.type/.test(x.sql))
      expect(events, statements.map((x) => x.sql).join('\n\n')).toBeDefined()
      const plan = await planOf(events!)
      expect(plan, `plan of:\n${events!.sql}\n\n${plan}`).toContain('SEARCH m USING INDEX idx_feed_events_created')
      expect(plan).not.toMatch(/SCAN m\b/)
    })

    it('costs the same number of statements for a page of 50 as for a page of 2', async () => {
      await seedDay(60)
      const small = await capture(() => list('?page=1&limit=2'))
      const full = await capture(() => list('?page=1'))
      expect(small.result.entries).toHaveLength(2)
      expect(full.result.entries).toHaveLength(50)
      expect(full.statements.length).toBe(small.statements.length)
    })
  })

  describe('the row\'s list, with companion groups and new matches (#920)', () => {
    const list = async (qs: string) => {
      const res = await SELF.fetch(`http://localhost/api/feed/events/row-2026-03-04/bills${qs}`, { headers: { Cookie: `session=${token}` } })
      expect(res.status).toBe(200)
      return await res.json() as { entries: Array<{ newMatch: boolean }> }
    }

    it('costs the same number of statements for 50 entries that are companion groups and new matches as for 2', async () => {
      for (let i = 0; i < 60; i++) {
        await update(await seedBill({ billNumber: `HB ${i}`, relevanceScore: 1 + (i % 10), matchType: 'keyword', newMatchAt: '2026-03-01 08:00:00' }), `2026-03-04 09:${String(i % 60).padStart(2, '0')}:00`)
      }
      await env.DB.prepare(`UPDATE bills SET group_key = 'g' || id`).run()
      await row('2026-03-04')

      const small = await capture(() => list('?page=1&limit=2'))
      const full = await capture(() => list('?page=1'))
      expect(small.result.entries.every((e) => e.newMatch)).toBe(true)
      expect(full.result.entries).toHaveLength(50)
      expect(full.result.entries.every((e) => e.newMatch)).toBe(true)
      expect(full.statements.length).toBe(small.statements.length)
    })
  })

  // A realistic instance: 4,000 bills, 1,000 analyzed (50 prioritized, 60 in
  // companion pairs), and 30 days of 100 legislative updates a day, each day with
  // its row. Most bills move a few times a month, so the history the engagement
  // checks would read for every analyzed bill is the cost to avoid.
  it('reads a bounded number of rows on a realistic instance', async () => {
    await realistic({ triaged: false })
    const { result, statements } = await capture(getFeed)
    const rows = result.events.filter((e) => e.type === 'no_priority_updates')

    const resolving = statements.filter(isRowResolution)
    const read = { resolving: 0, list: await rowsRead(statements.find(isFeedList)!), count: await rowsRead(statements.find(isFeedCount)!) }
    for (const s of resolving) read.resolving += await rowsRead(s)
    const before = { list: await rowsReadAs(statements.find(isFeedList)!, asBefore), count: await rowsReadAs(statements.find(isFeedCount)!, asBefore) }
    console.log(`[no-priority row cost] realistic rows=${rows.length} statements=${statements.length} rows_read=${JSON.stringify(read)} as-joined-before=${JSON.stringify(before)}`)

    // The prioritized bills' updates are cards that share the page with the rows.
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.every((r) => (r.metadata.count ?? 0) > 50)).toBe(true)
    // Each row stands for a day of 100 updates: reading each update, its bill,
    // and that bill's engagement that day is a few rows an update.
    expect(read.resolving).toBeLessThan(rows.length * 100 * 12)
    expect(read.count).toBeLessThan(28 * 100 * 12)
  })

  // A triaged instance: every analyzed bill has a priority, so every day's row
  // stands for no bill, and the count must still look at each day's updates
  // only, never every analyzed bill once a day.
  it('reads a bounded number of rows counting a triaged instance\'s empty rows', async () => {
    await realistic({ triaged: true })
    const { result, statements } = await capture(getFeed)
    expect(result.events.filter((e) => e.type === 'no_priority_updates')).toEqual([])
    const count = statements.find(isFeedCount)!
    const read = await rowsRead(count)
    const before = await rowsReadAs(count, asBefore)
    console.log(`[no-priority row cost] triaged statements=${statements.length} count rows_read=${read} as-joined-before=${before}`)
    expect(read).toBeLessThan(28 * 100 * 12)
  })

  const rowsReadAs = async (s: Captured, rewrite: (q: string) => string) =>
    (await env.DB.prepare(rewrite(s.sql)).bind(...s.binds).all()).meta.rows_read

  async function realistic({ triaged }: { triaged: boolean }) {
    const stmts: string[] = []
    const bills: string[] = []
    for (let i = 0; i < 4000; i++) {
      const analyzed = i < 1000
      const priority = analyzed && (triaged || i % 20 === 0) ? `'high'` : 'NULL'
      const group = analyzed && i >= 900 && i < 960 ? `'g${Math.floor((i - 900) / 2)}'` : 'NULL'
      bills.push(`('b${i}', 'HB ${i}', 'Bill ${i}', 'RI', ${analyzed ? `'keyword'` : 'NULL'}, ${analyzed ? (i % 10) + 1 : 'NULL'}, ${priority}, ${group})`)
    }
    for (let i = 0; i < bills.length; i += 200) {
      stmts.push(`INSERT INTO bills (id, bill_number, title, state, match_type, relevance_score, priority, group_key) VALUES ${bills.slice(i, i + 200).join(', ')}`)
    }
    const events: string[] = []
    const day = (d: number) => `2026-02-${String(d + 1).padStart(2, '0')}`
    for (let d = 0; d < 28; d++) {
      events.push(`('row-${d}', 'no_priority_updates', NULL, 'system', '{}', '${day(d)} 00:30:00')`)
      for (let k = 0; k < 100; k++) {
        const bill = (d * 37 + k * 11) % 1000
        // Both stored timestamp formats.
        const at = k % 2 ? `${day(d)} ${String(k % 24).padStart(2, '0')}:15:00` : `${day(d)}T${String(k % 24).padStart(2, '0')}:45:00Z`
        events.push(`('e${d}-${k}', 'bill_updated', 'b${bill}', 'system', '{"changes":[]}', '${at}')`)
      }
    }
    for (let i = 0; i < events.length; i += 200) {
      stmts.push(`INSERT INTO feed_events (id, type, bill_id, user_id, metadata, created_at) VALUES ${events.slice(i, i + 200).join(', ')}`)
    }
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s)))
  }
})
