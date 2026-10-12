import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'

// The default feed sorts by datetime(created_at) because feed_events holds two
// UTC formats that order differently as strings. Wrapping the column in a
// function makes idx_feed_events_created unusable for the sort, so every feed
// load built a temp B-tree over the whole result set. 0087 adds an expression
// index on the exact same expression. SQLite matches expression indexes
// textually, so this test captures the SQL the route really prepares and reads
// the plan for it, rather than restating the query by hand.
describe('feed sort expression index', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('serves the default feed ORDER BY without a temp B-tree', async () => {
    const userId = await seedUser({ name: 'Alice' })
    const token = await seedSession(userId)
    await seedBill({ billNumber: 'HB 1' })

    const prepared: string[] = []
    const realPrepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      prepared.push(sql)
      return realPrepare(sql)
    })
    const res = await SELF.fetch('http://localhost/api/feed', { headers: { Cookie: `session=${token}` } })
    spy.mockRestore()
    expect(res.status).toBe(200)

    const feedSql = prepared.find((s) => /order by datetime\(/i.test(s) && /limit/i.test(s))
    expect(feedSql, `no feed query captured among:\n${prepared.join('\n')}`).toBeDefined()

    const params = (feedSql!.match(/\?/g) ?? []).map(() => 'x')
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${feedSql}`)
      .bind(...params)
      .all<{ detail: string }>()
    const plan = results.map((r) => r.detail).join('\n')

    expect(plan, `plan:\n${plan}`).not.toContain('USE TEMP B-TREE FOR ORDER BY')
    expect(plan).toContain('idx_feed_events_created_dt')
  })
})
