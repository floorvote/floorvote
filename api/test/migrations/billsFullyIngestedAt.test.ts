import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, parseMigration } from '../helpers'
import migrationSql from '../../migrations/0117_bills_fully_ingested_at.sql?raw'

// applyMigrations() has already added the column, so this runs only the
// migration's UPDATE against rows seeded in the shapes it must tell apart.
describe('0117_bills_fully_ingested_at backfill', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  async function seed(id: string, extra: string, values: unknown[]) {
    await env.DB.prepare(
      `INSERT INTO bills (id, external_id, bill_number, title, state, status, session, updated_at ${extra ? ', ' + extra : ''})
       VALUES (?, ?, 'HB 1', 'T', 'DC', 'introduced', '', '2026-05-01 00:00:00' ${values.length ? ', ' + values.map(() => '?').join(', ') : ''})`,
    ).bind(id, `x:${id}`, ...values).run()
  }
  const mark = async (id: string) =>
    (await env.DB.prepare('SELECT fully_ingested_at AS m FROM bills WHERE id = ?').bind(id).first<{ m: string | null }>())?.m

  it('marks tracked and analyzed bills, and leaves a metadata-only bill with a text key unmarked', async () => {
    await seed('tracked', 'match_type', ['keyword'])
    await seed('analyzed', 'ai_processed_at', ['2026-05-02 00:00:00'])
    await seed('metadata-only', 'text_r2_key', ['bills/x/v1.html'])
    await seed('stub', '', [])

    const update = parseMigration(migrationSql, '0117_bills_fully_ingested_at').queries.find(q => /^\s*UPDATE/i.test(q))!
    await env.DB.prepare(update).run()

    expect(await mark('tracked')).toBe('2026-05-01 00:00:00')
    expect(await mark('analyzed')).toBe('2026-05-01 00:00:00')
    expect(await mark('metadata-only')).toBeNull()
    expect(await mark('stub')).toBeNull()
  })

  it('leaves an existing mark alone when run again', async () => {
    await seed('marked', 'match_type, fully_ingested_at', ['keyword', '2026-04-01 00:00:00'])
    const update = parseMigration(migrationSql, '0117_bills_fully_ingested_at').queries.find(q => /^\s*UPDATE/i.test(q))!
    await env.DB.prepare(update).run()
    expect(await mark('marked')).toBe('2026-04-01 00:00:00')
  })
})
