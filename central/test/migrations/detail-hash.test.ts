import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'
import { splitStatements } from '../../../shared/sqlStatements'

// 0041 on a central that already holds bills: it adds the marker of the change
// each bill's detail was last fetched at, and fills it in for bills whose
// detail is known to be current, so their first views spend no budget.

const before0041: MigrationFiles = Object.fromEntries(
  Object.entries(legiscanMigrations).filter(([path]) => path.split('/').pop()! < '0041'))
const file0041 = Object.entries(legiscanMigrations).find(([path]) => path.split('/').pop()!.startsWith('0041'))?.[1] ?? ''

type Seed = { id: number; lastActionDate: string | null; history: string[]; link: 'keyword' | 'manual' | null }
const SEEDS: Seed[] = [
  // Tracked: the sync ingests it whenever it changes.
  { id: 1, lastActionDate: '2026-04-01', history: ['2026-01-15'], link: 'keyword' },
  { id: 2, lastActionDate: '2026-04-01', history: [], link: 'manual' },
  // A stub whose history reaches its last action.
  { id: 3, lastActionDate: '2026-04-01', history: ['2026-01-15', '2026-04-01'], link: null },
  // A stub whose last action is newer than its history: the gap the refresh closes.
  { id: 4, lastActionDate: '2026-04-01', history: ['2026-01-15'], link: null },
  // A stub whose detail was never fetched.
  { id: 5, lastActionDate: '2026-04-01', history: [], link: null },
  // A stub with history and no last action to gap against.
  { id: 6, lastActionDate: null, history: ['2026-01-15'], link: null },
]

beforeEach(async () => {
  await setupDb(before0041)
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name)
      VALUES (2154, 50, 'WI', 2025, 2026, '', 'Regular', '2025-2026 Regular')`),
    env.DB.prepare(`INSERT INTO tenants (tenant_id, name, state_coverage) VALUES ('a', 'A', '["WI"]')`),
  ]
  for (const s of SEEDS) {
    stmts.push(env.DB.prepare(`INSERT INTO bills (bill_id, change_hash, session_id, state, state_id, bill_number, title, last_action_date)
      VALUES (?, ?, 2154, 'WI', 50, ?, ?, ?)`).bind(s.id, `hash-${s.id}`, `AB${s.id}`, `Bill ${s.id}`, s.lastActionDate))
    stmts.push(env.DB.prepare(`INSERT INTO bill_tenants (bill_id, tenant_id, match_type) VALUES (?, 'a', ?)`).bind(s.id, s.link))
    s.history.forEach((date, seq) => stmts.push(env.DB.prepare(
      `INSERT INTO bill_history (id, bill_id, date, action, importance, seq) VALUES (?, ?, ?, 'Action', 1, ?)`)
      .bind(crypto.randomUUID(), s.id, date, seq)))
  }
  await env.DB.batch(stmts)
  await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
})

async function rows() {
  // SELECT *, so a missing column reads as undefined rather than failing the query.
  const { results } = await env.DB.prepare('SELECT * FROM bills ORDER BY bill_id').all<Record<string, unknown>>()
  return results.map(r => ({
    bill_id: r.bill_id, change_hash: r.change_hash,
    detail_hash: r.detail_hash, detail_requested_hash: r.detail_requested_hash, detail_requested_at: r.detail_requested_at,
  }))
}

describe('0041 on existing bills', () => {
  it('adds the detail marker and the refresh claim to bills', async () => {
    const { results } = await env.DB.prepare('PRAGMA table_info(bills)').all<{ name: string }>()
    expect(results.map(c => c.name)).toEqual(expect.arrayContaining(['detail_hash', 'detail_requested_hash', 'detail_requested_at']))
  })

  it('marks tracked bills and stubs whose history reaches their last action as current, and leaves the rest stale', async () => {
    const byId = Object.fromEntries((await rows()).map(r => [r.bill_id, r.detail_hash]))
    expect(byId).toEqual({
      1: 'hash-1',
      2: 'hash-2',
      3: 'hash-3',
      4: null,
      5: null,
      6: 'hash-6',
    })
  })

  it('claims no refresh for any bill', async () => {
    for (const r of await rows()) {
      expect(r.detail_requested_hash).toBeNull()
      expect(r.detail_requested_at).toBeNull()
    }
  })

  it('changes nothing when the migrations are applied again', async () => {
    const first = await rows()
    expect(first.every(r => 'detail_hash' in r && r.detail_hash !== undefined)).toBe(true)
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    expect(await rows()).toEqual(first)
  })

  it('changes nothing when its backfill runs again over bills a refresh has since moved', async () => {
    const backfill = splitStatements(file0041).filter(q => /^\s*UPDATE/i.test(q.replace(/^\s*--.*$/gm, '')))
    expect(backfill.length).toBeGreaterThan(0)
    // A stale stub fetched since, and a current one the sync has moved past.
    await env.DB.prepare(`UPDATE bills SET detail_hash = 'hash-4' WHERE bill_id = 4`).run()
    await env.DB.prepare(`UPDATE bills SET change_hash = 'hash-3b' WHERE bill_id = 3`).run()
    const first = await rows()
    for (const q of backfill) await env.DB.prepare(q).run()
    expect(await rows()).toEqual(first)
  })
})
