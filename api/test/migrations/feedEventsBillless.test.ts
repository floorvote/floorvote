import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb, parseMigration, seedBill, seedUser } from '../helpers'
import migrationSql from '../../migrations/0093_feed_events_billless.sql?raw'

describe('migration 0093_feed_events_billless', () => {
  let billA: string
  let billB: string
  let userId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    await env.DB.prepare('PRAGMA foreign_keys = ON').run()
    userId = await seedUser()
    billA = await seedBill({ billNumber: 'HB 1' })
    billB = await seedBill({ billNumber: 'HB 2' })
  })

  const insert = (id: string, type: string, billId: string | null, metadata = '{}', createdAt = '2026-01-01 10:00:00') =>
    env.DB.prepare(
      'INSERT INTO feed_events (id, type, bill_id, user_id, metadata, suppressed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).bind(id, type, billId, userId, metadata, createdAt).run()

  const rerun = async () => {
    const { queries } = parseMigration(migrationSql, '0093')
    await env.DB.batch(queries.map((q) => env.DB.prepare(q)))
  }

  it('accepts an event with no bill and still rejects an unknown bill', async () => {
    await insert('e1', 'priority_set', null, '{"priority":"high","count":34,"billIds":["x"]}')
    const row = await env.DB.prepare(`SELECT bill_id FROM feed_events WHERE id = 'e1'`).first()
    expect(row).toEqual({ bill_id: null })
    await expect(insert('e2', 'priority_set', 'no-such-bill')).rejects.toThrow()
  })

  it('still cascades a bill-pinned event on bill delete but leaves a bill-less one', async () => {
    await insert('pinned', 'comment_added', billA)
    await insert('bulk', 'priority_set', null, `{"priority":"high","count":11,"billIds":["${billA}"]}`)
    await env.DB.prepare('DELETE FROM bills WHERE id = ?').bind(billA).run()
    const { results } = await env.DB.prepare('SELECT id FROM feed_events ORDER BY id').all()
    expect(results).toEqual([{ id: 'bulk' }])
  })

  it('carries rows across the rebuild and keeps every index, including the datetime(created_at) one', async () => {
    await insert('keep', 'comment_added', billB, '{"preview":"hi"}', '2026-02-02 03:04:05')
    await rerun()
    const row = await env.DB.prepare(`SELECT * FROM feed_events WHERE id = 'keep'`).first()
    expect(row).toEqual({
      id: 'keep', type: 'comment_added', bill_id: billB, user_id: userId,
      metadata: '{"preview":"hi"}', suppressed: 0, created_at: '2026-02-02 03:04:05',
    })
    const { results } = await env.DB.prepare(`PRAGMA index_list(feed_events)`).all()
    expect((results as Array<{ name: string }>).map((i) => i.name).filter((n) => n.startsWith('idx_')).sort())
      .toEqual(['idx_feed_events_bill_id', 'idx_feed_events_created', 'idx_feed_events_created_dt'])
  })

  it('converts an existing bulk event to bill-less, keeping the one bill id it has', async () => {
    await insert('old-bulk', 'priority_set', billA, '{"priority":"high","isBulk":true,"count":34}')
    await insert('old-bulk-pos', 'position_set', billB, '{"position":"Support","isBulk":true,"count":12}')
    await insert('routine', 'priority_set', billB, '{"priority":"low"}')
    await rerun()

    const bulk = await env.DB.prepare(`SELECT bill_id, metadata FROM feed_events WHERE id = 'old-bulk'`).first<{ bill_id: string | null; metadata: string }>()
    expect(bulk!.bill_id).toBeNull()
    expect(JSON.parse(bulk!.metadata)).toEqual({ priority: 'high', count: 34, billIds: [billA] })

    const pos = await env.DB.prepare(`SELECT bill_id, metadata FROM feed_events WHERE id = 'old-bulk-pos'`).first<{ bill_id: string | null; metadata: string }>()
    expect(pos!.bill_id).toBeNull()
    expect(JSON.parse(pos!.metadata)).toEqual({ position: 'Support', count: 12, billIds: [billB] })

    const routine = await env.DB.prepare(`SELECT bill_id, metadata FROM feed_events WHERE id = 'routine'`).first()
    expect(routine).toEqual({ bill_id: billB, metadata: '{"priority":"low"}' })
  })
})
