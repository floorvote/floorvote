import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, seedBill } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'
import { parseHandle } from '../../../shared/billHandle'

// Release 2 of the neutral handle rename (#305): migration 0119 rewrites the
// demo's bills to `bill:<n>`, and the bills a demo instance receives afterwards
// arrive stored that way too, while the seed still names them `legiscan:<n>`.
// A reset must attach its content to a bill stored under either spelling, and
// end in the same state either way.

const seed = DEMO_SEEDS['lake-michigan']
const TABLES = ['comments', 'member_votes', 'notes', 'feed_events', 'official_positions', 'bill_custom_field_values', 'calendar_events']

async function seedBills(spell: (id: number, i: number) => string) {
  for (const [i, p] of seed.priorities.entries()) {
    const id = parseHandle(p.externalId)!
    await seedBill({ id: `bill-${id}`, externalId: spell(id, i), billNumber: `B${1000 + i}`, title: `Bill ${i}`, state: 'MI', priority: null })
  }
}

/** Rows per table, and each bill's priority, after a reset. */
async function state() {
  const counts: Record<string, number> = {}
  for (const t of TABLES) counts[t] = (await env.DB.prepare(`SELECT count(*) AS n FROM ${t} WHERE bill_id IS NOT NULL`).first<{ n: number }>())!.n
  const priorities = (await env.DB.prepare('SELECT id, priority FROM bills ORDER BY id').all<{ id: string; priority: string | null }>()).results
  return { counts, priorities }
}

describe('a demo reset over bills stored under the neutral handle', () => {
  beforeEach(async () => {
    await clearDb()
  })

  // The reset clears every other bill's priority in one NOT IN that binds both
  // spellings of each seeded priority. D1 refuses a statement over 100 binds.
  it.each(Object.entries(DEMO_SEEDS))('keeps the %s seed\'s priority clear-out under D1\'s 100-bind limit', async (_, s) => {
    const binds: number[] = []
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (!/UPDATE bills SET priority = NULL WHERE external_id NOT IN/.test(sql)) return stmt
            return new Proxy(stmt, { get(t, p) { return p === 'bind' ? (...v: unknown[]) => { binds.push(v.length); return t.bind(...v) } : Reflect.get(t, p, t) } })
          }
        }
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    await runDemoReset(db, s)
    expect(binds).toHaveLength(1)
    expect(binds[0]).toBeGreaterThan(0)
    expect(binds[0]).toBeLessThanOrEqual(100)
  })

  it('the seed still names its bills by legacy handles, which is what this guards', () => {
    expect(seed.priorities.every(p => p.externalId.startsWith('legiscan:'))).toBe(true)
  })

  it('attaches the same content as over legacy-stored bills', async () => {
    await seedBills(id => `legiscan:${id}`)
    await runDemoReset(env.DB, seed)
    const legacy = await state()
    expect(Object.values(legacy.counts).every(n => n > 0)).toBe(true)

    await clearDb()
    await seedBills(id => `bill:${id}`)
    await runDemoReset(env.DB, seed)
    expect(await state()).toEqual(legacy)
  })

  it('attaches the same content when the bills are partly migrated', async () => {
    await seedBills(id => `legiscan:${id}`)
    await runDemoReset(env.DB, seed)
    const legacy = await state()

    await clearDb()
    await seedBills((id, i) => (i % 2 === 0 ? `bill:${id}` : `legiscan:${id}`))
    await runDemoReset(env.DB, seed)
    expect(await state()).toEqual(legacy)
  })

  it('keeps the seeded priorities on neutral-stored bills, and clears only the others', async () => {
    await seedBills(id => `bill:${id}`)
    await seedBill({ id: 'stray', externalId: 'bill:999999999', billNumber: 'S1', title: 'Stray', state: 'MI', priority: 'high' })
    await runDemoReset(env.DB, seed)
    const rows = (await env.DB.prepare('SELECT id, priority FROM bills').all<{ id: string; priority: string | null }>()).results
    const byId = new Map(rows.map(r => [r.id, r.priority]))
    for (const p of seed.priorities) expect(byId.get(`bill-${parseHandle(p.externalId)}`), p.externalId).toBe(p.priority)
    expect(byId.get('stray')).toBeNull()
  })
})
