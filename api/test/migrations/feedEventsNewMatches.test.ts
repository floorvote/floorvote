import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb, parseMigration, seedBill, seedUser } from '../helpers'
import migrationSql from '../../migrations/0099_feed_events_new_matches.sql?raw'

describe('migration 0099_feed_events_new_matches', () => {
  let bill: string
  let userId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser()
    bill = await seedBill({ billNumber: 'HB 1' })
  })

  const insert = (id: string, type: string, billId: string | null, createdAt: string, metadata = '{}') =>
    env.DB.prepare(
      'INSERT INTO feed_events (id, type, bill_id, user_id, metadata, suppressed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).bind(id, type, billId, userId, metadata, createdAt).run()

  it('accepts a new_matches event that belongs to no bill', async () => {
    await insert('m1', 'new_matches', null, '2026-03-01 10:00:00', '{"billIds":["a"]}')
    const row = await env.DB.prepare(`SELECT type, bill_id FROM feed_events WHERE id = 'm1'`).first()
    expect(row).toEqual({ type: 'new_matches', bill_id: null })
  })

  it('allows one new_matches row per day and no more', async () => {
    await insert('m1', 'new_matches', null, '2026-03-01 10:00:00')
    await expect(insert('m2', 'new_matches', null, '2026-03-01 23:59:59')).rejects.toThrow()
    await insert('m3', 'new_matches', null, '2026-03-02 00:00:00')
  })

  it('leaves every other event type free to repeat within a day', async () => {
    await insert('p1', 'priority_set', bill, '2026-03-01 10:00:00')
    await insert('p2', 'priority_set', bill, '2026-03-01 11:00:00')
    await insert('b1', 'bill_matched', bill, '2026-03-01 12:00:00')
  })

  it('carries rows across the rebuild and keeps every index', async () => {
    await insert('keep', 'comment_added', bill, '2026-02-02 03:04:05', '{"preview":"hi"}')
    await insert('m1', 'new_matches', null, '2026-03-01 10:00:00', '{"billIds":["a"]}')
    const { queries } = parseMigration(migrationSql, '0099')
    await env.DB.batch(queries.map((q) => env.DB.prepare(q)))

    const rows = await env.DB.prepare(`SELECT id, type, bill_id, metadata, created_at FROM feed_events ORDER BY id`).all()
    expect(rows.results).toEqual([
      { id: 'keep', type: 'comment_added', bill_id: bill, metadata: '{"preview":"hi"}', created_at: '2026-02-02 03:04:05' },
      { id: 'm1', type: 'new_matches', bill_id: null, metadata: '{"billIds":["a"]}', created_at: '2026-03-01 10:00:00' },
    ])
    const { results } = await env.DB.prepare(`PRAGMA index_list(feed_events)`).all()
    expect((results as Array<{ name: string }>).map((i) => i.name).filter((n) => n.startsWith('idx_')).sort())
      .toEqual(['idx_feed_events_bill_id', 'idx_feed_events_created', 'idx_feed_events_created_dt', 'idx_feed_events_new_matches_day'])
  })
})
