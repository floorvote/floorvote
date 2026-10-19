import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { setupLsDb } from '../helpers/setupLsDb'

// The sync pass reads a bill's relations from both sides (cron/sync.ts), the
// companion's side by sast_bill_id. Without an index that is a scan of the whole
// table per chunk of the session's bills.

beforeEach(setupLsDb)

async function plan(sql: string): Promise<string> {
  const rows = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).results as { detail: string }[]
  return rows.map(r => r.detail).join(' | ')
}

describe('bill_sasts indexes', () => {
  it('looks a bill up by the bill that names it with an index, not a scan', async () => {
    const p = await plan('SELECT bill_id, sast_bill_id, type FROM bill_sasts WHERE sast_bill_id IN (1, 2, 3)')
    expect(p).toContain('USING INDEX idx_bill_sasts_sast_bill_id')
    expect(p).not.toMatch(/SCAN bill_sasts/)
  })

  it('still looks a bill up by its own id with its index', async () => {
    expect(await plan('SELECT sast_bill_id FROM bill_sasts WHERE bill_id IN (1, 2)')).toContain('idx_bill_sasts_bill')
  })
})
