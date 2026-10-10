import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0078: DC's LIMS status Expired moves from failed to enacted (#294), so a
// fork's DC bills that 0076 backfilled sort and filter as central now sends them.
describe('0078_expired_status_enacted', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0078' })
    const insert = env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, status, status_stage, status_rank) VALUES (?, ?, 'Bill', 'DC', ?, ?, ?)`)
    await env.DB.batch([
      insert.bind('expired', 'B26-0001', 'Expired', 'failed', 507),
      insert.bind('law', 'B26-0400', 'Official Law', 'enacted', 705),
      insert.bind('failed', 'HB 1', 'Failed', 'failed', 501),
    ])
    await applyMigrations()
  })

  it('stages Expired as enacted, after Official Law, and leaves every other status alone', async () => {
    const { results } = await env.DB.prepare(`SELECT id, status_stage AS stage, status_rank AS rank FROM bills ORDER BY status_rank`)
      .all<{ id: string; stage: string; rank: number }>()
    expect(results).toEqual([
      { id: 'failed', stage: 'failed', rank: 501 },
      { id: 'law', stage: 'enacted', rank: 705 },
      { id: 'expired', stage: 'enacted', rank: 706 },
    ])
  })
})
