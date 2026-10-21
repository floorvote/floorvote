import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb, parseMigration, seedBill, seedUser } from '../helpers'
import migrationSql from '../../migrations/0121_feed_events_no_priority_updates.sql?raw'

// 0121 widens the feed_events type CHECK for the no-priority updates row, which
// means rebuilding the table as 0099 did. A rebuild drops every index with the
// old table, so this checks the rows and the indexes both come through, on a
// database that holds every event type there was before it.
const EXISTING_TYPES = [
  'bill_added', 'priority_set', 'position_set', 'comment_added', 'vote_milestone', 'bill_updated',
  'hearing_added', 'hearing_changed', 'hearing_cancelled', 'bill_matched', 'new_matches',
] as const

const INDEXES = [
  'idx_feed_events_bill_id', 'idx_feed_events_created', 'idx_feed_events_created_dt',
  'idx_feed_events_new_matches_day', 'idx_feed_events_no_priority_updates_day',
]

describe('migration 0121_feed_events_no_priority_updates', () => {
  let bill: string
  let userId: string

  const insert = (id: string, type: string, billId: string | null, createdAt: string, metadata = '{}', suppressed = 0) =>
    env.DB.prepare(
      'INSERT INTO feed_events (id, type, bill_id, user_id, metadata, suppressed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, type, billId, userId, metadata, suppressed, createdAt).run()
  const rows = async () => (await env.DB.prepare('SELECT id, type, bill_id, user_id, metadata, suppressed, created_at FROM feed_events ORDER BY id').all()).results
  const indexes = async () => {
    const { results } = await env.DB.prepare('PRAGMA index_list(feed_events)').all<{ name: string }>()
    return results.map((i) => i.name).filter((n) => n.startsWith('idx_')).sort()
  }
  const runAgain = async () => {
    const { queries } = parseMigration(migrationSql, '0121')
    await env.DB.batch(queries.map((q) => env.DB.prepare(q)))
  }

  describe('over a database from before it', () => {
    let before: unknown[]

    beforeEach(async () => {
      await resetDb()
      await applyMigrations({ before: '0121' })
      userId = await seedUser()
      bill = await seedBill({ billNumber: 'HB 1' })
      for (const [i, type] of EXISTING_TYPES.entries()) {
        const billless = type === 'new_matches'
        await insert(`e${String(i).padStart(2, '0')}`, type, billless ? null : bill, `2026-02-0${1 + (i % 9)} 0${i % 10}:04:05`, billless ? '{"billIds":["a"]}' : `{"n":${i}}`, i % 2)
      }
      // A bill-less bulk edit, and the other stored timestamp format.
      await insert('z-bulk', 'priority_set', null, '2026-01-01T10:00:00Z', '{"priority":"high","count":2,"billIds":["a","b"]}')
      before = await rows()
      await applyMigrations()
    })

    it('carries every row across the rebuild unchanged', async () => {
      expect(before).toHaveLength(EXISTING_TYPES.length + 1)
      expect(await rows()).toEqual(before)
    })

    it('keeps every index and adds the row\'s one-a-day index', async () => {
      expect(await indexes()).toEqual(INDEXES)
    })

    it('keeps a bill\'s events cascading with it, and a bill-less event surviving any deletion', async () => {
      await env.DB.prepare('DELETE FROM bills WHERE id = ?').bind(bill).run()
      expect((await rows()).map((r) => (r as { id: string }).id)).toEqual(['e10', 'z-bulk'])
    })

    it('is safe to run a second time, keeping rows and indexes', async () => {
      await insert('np1', 'no_priority_updates', null, '2026-03-01 06:00:00')
      const after = await rows()
      await runAgain()
      expect(await rows()).toEqual(after)
      expect(await indexes()).toEqual(INDEXES)
    })
  })

  describe('the new type', () => {
    beforeEach(async () => {
      await resetDb()
      await applyMigrations()
      userId = await seedUser()
      bill = await seedBill({ billNumber: 'HB 1' })
    })

    it('accepts a no_priority_updates event that belongs to no bill', async () => {
      await insert('np1', 'no_priority_updates', null, '2026-03-01 06:00:00')
      expect(await env.DB.prepare(`SELECT type, bill_id FROM feed_events WHERE id = 'np1'`).first())
        .toEqual({ type: 'no_priority_updates', bill_id: null })
    })

    it('allows one no_priority_updates row per day and no more', async () => {
      await insert('np1', 'no_priority_updates', null, '2026-03-01 06:00:00')
      await expect(insert('np2', 'no_priority_updates', null, '2026-03-01 23:59:59')).rejects.toThrow()
      await insert('np3', 'no_priority_updates', null, '2026-03-02 00:00:00')
    })

    it('lets the new-matches row share its day', async () => {
      await insert('np1', 'no_priority_updates', null, '2026-03-01 06:00:00')
      await insert('nm1', 'new_matches', null, '2026-03-01 07:00:00', '{"billIds":[]}')
    })

    it('still rejects a type it doesn\'t know', async () => {
      await expect(insert('x', 'something_else', bill, '2026-03-01 06:00:00')).rejects.toThrow()
    })
  })
})
