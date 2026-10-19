import { describe, it, expect, vi, beforeAll } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession } from '../helpers'
import { centralFetch } from '../../src/lib/centralFetch'

// The query plans of the companion suggestion's lookup (#521). The lookup runs
// on every admin's view of a bill in an opted-in state, so it must read the
// few bills of one state and session that hold the bill's title key, through
// idx_bills_title_key, and never the bills table. A whole-state title
// self-join once exceeded D1's CPU limit and reset a production database.
// Like groupTagsPlan.test.ts, this reads the plans of the SQL the route really
// prepares, on statistics like a large instance's.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

type Stmt = { sql: string; params: unknown[] }
type Planned = { sql: string; params: unknown[]; plan: string }

// The bill viewed, and the key every fifth bill of its session holds in pairs.
const VIEWED = 'bill00010'
const keyOf = (i: number) => `B|an act relating to subject number ${Math.floor(i / 10)} of this session`

describe('companion suggestion query plans', () => {
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
    const res = await app.request(`/api/${path}`, { headers: { Cookie: cookie } }, { ...env, TENANT_ID: 'test-org' })
    spy.mockRestore()
    expect(res.status).toBe(200)
    const body = await res.json() as { companionSuggestion?: { billId: string } | null }
    // The lookup ran and found the pair, so the plans below are of the statements that found it.
    expect(body.companionSuggestion).toEqual(expect.objectContaining({ billId: 'bill00011' }))
    const out: Planned[] = []
    for (const s of seen) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...s.params).all<{ detail: string }>()
      out.push({ sql: s.sql, params: s.params, plan: results.map(r => r.detail).join('\n') })
    }
    return out
  }
  // A statement that looks bills up by title key, not one that only reads the column.
  const isLookup = (p: Planned) => /^\s*select/i.test(p.sql) && /title_key"?\s*=\s*\?/i.test(p.sql)
  // A full read of the bills table, under any alias, not of one of its indexes.
  const SCANS_BILLS = /SCAN (bills|b|o|other)\b(?! USING)/

  beforeAll(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser({ role: 'admin' })
    cookie = `session=${await seedSession(userId)}`
    // 40,000 bills in two states and four sessions each. In one state, every bill has a chamber and every
    // other bill a title key, so a session holds 5,000 keys in pairs of a House and a Senate bill.
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40000)
        INSERT INTO bills (id, external_id, bill_number, title, state, session, session_id, match_type, chamber, title_key)
        SELECT 'bill' || printf('%05d', i), 'legiscan:' || i, CASE i % 2 WHEN 0 THEN 'HB' ELSE 'SB' END || i, 'Title ' || i,
          CASE WHEN i <= 20000 THEN 'PA' ELSE 'ZZ' END, 's', CASE WHEN i <= 20000 THEN 'pa:' ELSE 'zz:' END || (i % 4),
          CASE WHEN i % 7 = 0 THEN 'keyword' END,
          CASE i % 2 WHEN 0 THEN 'H' ELSE 'S' END,
          CASE WHEN i <= 20000 AND (i / 2) % 2 = 0 THEN 'B|an act relating to subject number ' || (i / 2) || ' of this session' END
        FROM n`),
      env.DB.prepare('ANALYZE'),
    ])
    // The viewed bill and its companion: the only two with their key, one in each chamber of one session.
    const key = keyOf(10)
    await env.DB.prepare(`UPDATE bills SET title_key = ?, session_id = 'pa:2', chamber = CASE id WHEN ? THEN 'H' ELSE 'S' END, match_type = 'keyword' WHERE id IN (?, 'bill00011')`)
      .bind(key, VIEWED, VIEWED).run()
    vi.mocked(centralFetch).mockImplementation(async (_env, path: string) =>
      new Response(JSON.stringify(path.includes('/bills/legiscan:10') || path.includes('/bills/10') ? { titleKey: key, body: 'H' } : {}), { status: 200 }))
  })

  it('reads the bills that hold the key through idx_bills_title_key, never the bills table', async () => {
    const plans = await plansFor(`bills/${VIEWED}`)
    const lookups = plans.filter(isLookup)
    expect(lookups.length).toBeGreaterThan(0)
    for (const p of lookups) {
      expect(p.plan, p.sql).toMatch(/idx_bills_title_key/)
      expect(p.plan, p.sql).not.toMatch(SCANS_BILLS)
    }
  })

  it('bounds the lookup by state and session, and caps the rows it reads', async () => {
    const plans = await plansFor(`bills/${VIEWED}`)
    const lookups = plans.filter(isLookup)
    expect(lookups.length).toBeGreaterThan(0)
    for (const p of lookups) {
      expect(p.params, p.sql).toEqual(expect.arrayContaining(['PA', 'pa:2', keyOf(10)]))
      expect(p.sql, p.sql).toMatch(/\blimit\b/i)
      expect(p.plan, p.sql).toMatch(/USING INDEX idx_bills_title_key \(state=\? AND session_id=\? AND title_key=\?\)/)
    }
  })

  it('reads the pair\'s overrides and dismissals by primary key', async () => {
    const plans = await plansFor(`bills/${VIEWED}`)
    const pairReads = plans.filter(p => /companion_suggestion_dismissals/.test(p.sql))
    expect(pairReads.length).toBeGreaterThan(0)
    for (const p of pairReads) {
      expect(p.plan, p.sql).not.toMatch(/SCAN (companion_suggestion_dismissals|bill_group_overrides)\b(?! USING)/)
    }
  })
})
