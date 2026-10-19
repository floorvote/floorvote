import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'

// 0045 on a central that already holds sync log rows: every pass logged before
// it was a pass that finished, so its rows read 'ok', and a failed pass is a row
// with its own status and the error that ended it.

const before0045: MigrationFiles = Object.fromEntries(
  Object.entries(legiscanMigrations).filter(([path]) => path.split('/').pop()! < '0045'))
const file0045 = Object.entries(legiscanMigrations).find(([path]) => path.split('/').pop()!.startsWith('0045'))?.[1]

type Col = { name: string; type: string; notnull: number; dflt_value: string | null }
const columns = async () => (await env.DB.prepare('PRAGMA table_info(session_sync_log)').all<Col>()).results
const log = async () => (await env.DB.prepare('SELECT * FROM session_sync_log ORDER BY id').all<Record<string, unknown>>()).results

beforeEach(async () => {
  await setupDb(before0045)
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO session_sync_log (synced_at, state, session_id, session_name, bills_checked, bills_changed, bills_queued)
      VALUES ('2026-10-01 05:00:00', 'RI', 1, 'RI 2026', 7, 2, 1), ('2026-10-01 13:00:00', 'RI', 1, 'RI 2026', 0, 0, 0)`),
  ])
})

describe('the sync log status migration (0045)', () => {
  it('exists', () => {
    expect(file0045).toBeDefined()
  })

  it('adds a status that is never null and defaults to ok, and a nullable error', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    const cols = Object.fromEntries((await columns()).map(c => [c.name, c]))
    expect(cols.status).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'ok'" })
    expect(cols.error).toMatchObject({ type: 'TEXT', notnull: 0 })
  })

  it('keeps every existing row and reads each as ok with no error', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    const rows = await log()
    expect(rows).toHaveLength(2)
    expect(rows.map(r => [r.bills_checked, r.status, r.error])).toEqual([[7, 'ok', null], [0, 'ok', null]])
  })

  it('writes a row that names no status as ok, which is how LegiScan passes log', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    await env.DB.prepare(`INSERT INTO session_sync_log (state, session_id, session_name) VALUES ('NJ', 2, 'NJ 2026')`).run()
    expect((await log()).at(-1)).toMatchObject({ state: 'NJ', status: 'ok', error: null })
  })

  it('stores a failed row with its error', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    await env.DB.prepare(`INSERT INTO session_sync_log (state, session_id, session_name, status, error) VALUES ('NJ', 2, 'NJ 2026', 'failed', 'boom')`).run()
    expect((await log()).at(-1)).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('applies once: a second run of the migrations skips it instead of adding the columns twice', async () => {
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
    expect((await columns()).filter(c => c.name === 'status')).toHaveLength(1)
    expect(await log()).toHaveLength(2)
  })

  it('applies on an empty database too', async () => {
    await setupDb(legiscanMigrations)
    expect((await columns()).map(c => c.name)).toEqual(expect.arrayContaining(['status', 'error']))
  })
})
