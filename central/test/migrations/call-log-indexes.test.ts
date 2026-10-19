import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'
import { setupLsDb } from '../helpers/setupLsDb'
import { planOf, spyOnD1 } from '../helpers/queryPlan'
import { loadStateRows } from '../../src/lib/stateRows'
import { pruneCallLogs } from '../../src/lib/pruneCallLogs'
import { splitStatements } from '../../../shared/sqlStatements'

// The States page reads api_call_log and session_sync_log on every load, and the
// Budget page, the sync ticks, and the retention job read them too. Without an
// index on the columns they filter and order by, each of those is a scan of a
// table that only ever grew.

const NOW = new Date('2026-10-14T15:30:00Z')
// Any SCAN of a log table, covering index or not, reads every row of it.
const NOT_FULL_SCAN = /\bSCAN (api_call_log|session_sync_log|l|l2)\b/

async function plan(sql: string): Promise<string> {
  const rows = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).results as { detail: string }[]
  return rows.map(r => r.detail).join(' | ')
}

describe('call-log indexes: the queries the States page runs', () => {
  beforeEach(async () => {
    await setupLsDb()
    // Rows and sessions so the planner has something to choose over.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name, provider)
        VALUES (1, 1, 'RI', 2026, 2026, '', 'Regular', 'RI 2026', 'legiscan')`),
      ...Array.from({ length: 50 }, (_, i) => env.DB.prepare(
        `INSERT INTO api_call_log (logged_at, call_type, params) VALUES (?, 'getBill', '{}')`).bind(`2026-10-${String(1 + (i % 14)).padStart(2, '0')} 05:00:00`)),
      ...Array.from({ length: 50 }, (_, i) => env.DB.prepare(
        `INSERT INTO session_sync_log (synced_at, state, session_id, session_name) VALUES (?, 'RI', 1, 'RI 2026')`).bind(`2026-10-${String(1 + (i % 14)).padStart(2, '0')} 05:00:00`)),
    ])
    await env.DB.prepare('ANALYZE').run()
  })

  async function statesQueries() {
    const { db, captured } = spyOnD1()
    await loadStateRows(drizzle(db, { schema }), { ...env } as any, NOW)
    const mentioning = (t: string) => captured.filter(c => c.sql.includes(t))
    return { api: mentioning('api_call_log'), sync: mentioning('session_sync_log') }
  }

  it('counts the month\'s calls through an index on logged_at, not a scan', async () => {
    const { api } = await statesQueries()
    expect(api.length).toBeGreaterThan(0)
    for (const q of api) {
      const p = await planOf(q)
      expect(p).toMatch(/SEARCH api_call_log USING (COVERING )?INDEX idx_api_call_log_/)
      expect(p).not.toMatch(NOT_FULL_SCAN)
    }
  })

  it('finds each state\'s latest pass through an index, with no scan of the log', async () => {
    const { sync } = await statesQueries()
    expect(sync.length).toBeGreaterThan(0)
    for (const q of sync) {
      const p = await planOf(q)
      expect(p).toMatch(/idx_session_sync_log_/)
      expect(p).not.toMatch(NOT_FULL_SCAN)
    }
  })

  it('reads the Budget page\'s month and 90-day windows by logged_at', async () => {
    const p = await plan(`SELECT substr(logged_at, 1, 10), COUNT(*) FROM api_call_log
      WHERE logged_at >= '2026-07-17T00:00:00.000Z' AND call_type NOT LIKE '%:%' GROUP BY substr(logged_at, 1, 10)`)
    expect(p).toMatch(/SEARCH api_call_log USING (COVERING )?INDEX idx_api_call_log_/)
  })

  it('reads the latest sync ticks, and a state\'s last tick, by synced_at without sorting the table', async () => {
    const all = await plan('SELECT id FROM session_sync_log ORDER BY synced_at DESC LIMIT 50')
    expect(all).toMatch(/idx_session_sync_log_/)
    expect(all).not.toMatch(/TEMP B-TREE/)
    const byState = await plan(`SELECT synced_at FROM session_sync_log WHERE state = 'RI' ORDER BY synced_at DESC LIMIT 1`)
    expect(byState).toMatch(/SEARCH session_sync_log USING (COVERING )?INDEX idx_session_sync_log_/)
    expect(byState).not.toMatch(/TEMP B-TREE/)
  })

  it('finds a session\'s next sync tick by session_id and synced_at', async () => {
    const p = await plan(`SELECT synced_at FROM session_sync_log WHERE session_id = 1 AND synced_at >= '2026-10-01 00:00:00' AND id != 3 ORDER BY synced_at LIMIT 1`)
    expect(p).toMatch(/SEARCH session_sync_log USING (COVERING )?INDEX idx_session_sync_log_/)
  })

  it('runs the retention job\'s deletes through the same indexes, not a scan', async () => {
    const { db, captured } = spyOnD1()
    await pruneCallLogs(drizzle(db, { schema }), NOW)
    const deletes = captured.filter(c => /DELETE FROM/i.test(c.sql))
    expect(deletes.length).toBeGreaterThanOrEqual(2)
    for (const q of deletes) {
      const p = await planOf(q)
      expect(p).toMatch(/INDEX idx_(api_call_log|session_sync_log)_/)
      expect(p).not.toMatch(NOT_FULL_SCAN)
    }
    // The check that a pass is its session's newest looks up the session's rows by index.
    const syncDelete = await planOf(deletes.find(c => c.sql.includes('DELETE FROM session_sync_log'))!)
    expect(syncDelete).toMatch(/SEARCH \w+ USING (COVERING )?INDEX idx_session_sync_log_session_synced/)
  })
})

// The migration on a central that already holds log rows, and run twice.
const before0044: MigrationFiles = Object.fromEntries(
  Object.entries(legiscanMigrations).filter(([path]) => path.split('/').pop()! < '0044'))
const file0044 = Object.entries(legiscanMigrations).find(([path]) => path.split('/').pop()!.startsWith('0044'))?.[1]

describe('the call-log index migration (0044)', () => {
  beforeEach(async () => {
    await setupDb(before0044)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO api_call_log (logged_at, call_type, params) VALUES ('2026-10-01 00:00:00', 'getBill', '{}'), ('2026-10-02T00:00:00.000Z', 'lims:Members', '{}')`),
      env.DB.prepare(`INSERT INTO session_sync_log (synced_at, state, session_id, session_name, bills_checked) VALUES ('2026-10-01 00:00:00', 'RI', 1, 'RI 2026', 7)`),
    ])
  })

  const indexNames = async (table: string) => ((await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'idx_%' ORDER BY name`).bind(table).all<{ name: string }>()).results).map(r => r.name)

  it('exists', () => {
    expect(file0044).toBeDefined()
  })

  it('applies over existing rows, keeps every row, and adds the indexes', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM api_call_log').first<{ n: number }>())!.n).toBe(2)
    expect((await env.DB.prepare('SELECT bills_checked FROM session_sync_log').first<{ bills_checked: number }>())!.bills_checked).toBe(7)
    expect(await indexNames('api_call_log')).toContain('idx_api_call_log_logged_at')
    expect((await indexNames('session_sync_log')).length).toBeGreaterThanOrEqual(2)
  })

  it('re-runs cleanly: every statement is safe to repeat', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    const before = [...await indexNames('api_call_log'), ...await indexNames('session_sync_log')]
    for (const stmt of splitStatements(file0044!)) await env.DB.prepare(stmt).run()
    expect([...await indexNames('api_call_log'), ...await indexNames('session_sync_log')]).toEqual(before)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM api_call_log').first<{ n: number }>())!.n).toBe(2)
  })

  it('applies on an empty database too', async () => {
    await setupLsDb()
    expect(await indexNames('api_call_log')).toContain('idx_api_call_log_logged_at')
  })
})
