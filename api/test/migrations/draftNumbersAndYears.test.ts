import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, parseMigration } from '../helpers'
import migrationSql70 from '../../migrations/0070_draft_numbers_and_years.sql?raw'

/** Run the backfill by hand, using the same parser production uses.
 *  applyMigrations() already ran it against an empty DB during setup, so
 *  seeding first and replaying is the only way to observe what it does to
 *  pre-existing rows. */
async function runBackfill(): Promise<void> {
  const { queries } = parseMigration(migrationSql70, '0070_draft_numbers_and_years')
  for (const q of queries) await env.DB.prepare(q).run()
}

describe('0070_draft_numbers_and_years', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('numbers drafts D1..Dn per state by creation order', async () => {
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state, is_draft, created_at)
       VALUES ('d1','DRAFT','First','UT',1,'2026-01-01 00:00:00'),
              ('d2','DRAFT','Second','UT',1,'2026-02-01 00:00:00'),
              ('n1','DRAFT','Nevada','NV',1,'2026-01-15 00:00:00')`,
    ).run()

    await runBackfill()

    const rows = await env.DB.prepare(
      `SELECT id, bill_number FROM bills WHERE is_draft = 1 ORDER BY id`,
    ).all()
    expect(rows.results).toEqual([
      { id: 'd1', bill_number: 'D1' },
      { id: 'd2', bill_number: 'D2' },
      { id: 'n1', bill_number: 'D1' },
    ])
  })

  it('sets the draft year from the newest filed bill in the same state', async () => {
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state, is_draft, year_start, year_end)
       VALUES ('f1','HB0001','Filed','UT',0,2025,2026)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state, is_draft, created_at)
       VALUES ('d1','DRAFT','Draft','UT',1,'2026-03-01 00:00:00')`,
    ).run()

    await runBackfill()

    const row = await env.DB.prepare(
      `SELECT year_start, year_end FROM bills WHERE id = 'd1'`,
    ).first()
    expect(row).toEqual({ year_start: 2026, year_end: 2026 })
  })

  it('leaves filed bills untouched', async () => {
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state, is_draft, year_start, year_end)
       VALUES ('f1','HB0209','Filed','UT',0,2026,2026)`,
    ).run()

    await runBackfill()

    const row = await env.DB.prepare(`SELECT bill_number FROM bills WHERE id = 'f1'`).first()
    expect(row?.bill_number).toBe('HB0209')
  })

  it('leaves a hand-set draft bill_number alone but still numbers its DRAFT siblings', async () => {
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state, is_draft, created_at)
       VALUES ('d1','SB0209-draft','Hand-numbered','UT',1,'2026-01-01 00:00:00'),
              ('d2','DRAFT','Second','UT',1,'2026-02-01 00:00:00')`,
    ).run()

    await runBackfill()

    const rows = await env.DB.prepare(
      `SELECT id, bill_number FROM bills WHERE is_draft = 1 ORDER BY id`,
    ).all()
    expect(rows.results).toEqual([
      { id: 'd1', bill_number: 'SB0209-draft' },
      { id: 'd2', bill_number: 'D2' },
    ])
  })

  it('is replay-safe', async () => {
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state, is_draft, created_at)
       VALUES ('d1','DRAFT','Only','UT',1,'2026-01-01 00:00:00')`,
    ).run()

    await runBackfill()
    await runBackfill()

    const row = await env.DB.prepare(`SELECT bill_number FROM bills WHERE id = 'd1'`).first()
    expect(row?.bill_number).toBe('D1')
  })
})
