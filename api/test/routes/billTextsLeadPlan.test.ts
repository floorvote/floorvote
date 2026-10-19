import { describe, it, expect, vi, beforeAll } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedUser, seedSession } from '../helpers'

// A grouped bill's newest text date picks its group's lead (lib/groupLead.ts).
// The list reads it for each grouped bill on a page, the bill-number sort for
// each grouped bill it orders, and the group_tags triggers for each member on
// every recompute. Each is one MAX over the bill's texts, which the covering
// index on bill_texts (bill_id, date), migration 0114, answers without reading
// the table. Like groupTagsPlan.test.ts, this reads the plans of the SQL the
// routes really prepare.

type Stmt = { sql: string; params: unknown[] }

describe('newest text date query plans', () => {
  let cookie: string

  async function plansFor(path: string): Promise<{ sql: string; plan: string }[]> {
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
    const out = []
    for (const s of seen) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...s.params).all<{ detail: string }>()
      out.push({ sql: s.sql, plan: results.map(r => r.detail).join('\n') })
    }
    return out
  }

  beforeAll(async () => {
    await clearDb()
    cookie = `session=${await seedSession(await seedUser({ role: 'admin' }))}`
    // 2,000 bills in pairs, each with three texts.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
        INSERT INTO bills (id, bill_number, title, state, status, status_rank, session, group_key)
        SELECT 'bill' || printf('%05d', i), 'HB ' || i, 'Title ' || i, 'TX', 'Introduced', 100, 's',
          'bill' || printf('%05d', ((i - 1) / 2) * 2 + 1) FROM n`),
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
        INSERT INTO bill_texts (id, bill_id, doc_id, type, date)
        SELECT 't' || i, 'bill' || printf('%05d', 1 + (i - 1) / 3), 'd' || i, 'Introduced', '2026-0' || (1 + i % 9) || '-01' FROM n`),
      env.DB.prepare('ANALYZE'),
    ])
  })

  const readsTexts = (p: { sql: string }) => /bill_texts/.test(p.sql)

  it('reads each grouped bill\'s newest text date from the covering index on the list', async () => {
    const plans = (await plansFor('bills?pageSize=50')).filter(readsTexts)
    expect(plans.length).toBeGreaterThan(0)
    for (const p of plans) expect(p.plan).toMatch(/USING COVERING INDEX idx_bill_texts_bill_date/)
  })

  it('reads it from the covering index for the bill-number sort', async () => {
    const plans = (await plansFor('bills?pageSize=50&sort=bill&dir=asc')).filter(readsTexts)
    expect(plans.length).toBeGreaterThan(0)
    for (const p of plans) expect(p.plan).toMatch(/USING COVERING INDEX idx_bill_texts_bill_date/)
  })

  it('reads it from the covering index in the group_tags recompute', async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT MAX(NULLIF(t.date, '')) FROM bill_texts t WHERE t.bill_id = ?`).bind('bill00001').all<{ detail: string }>()
    expect(results.map(r => r.detail).join('\n')).toMatch(/USING COVERING INDEX idx_bill_texts_bill_date/)
  })
})
