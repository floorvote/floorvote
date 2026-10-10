import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// The status strings tenant bills hold before 0076: LegiScan labels, the bare
// LegiScan codes central had no label for (7 to 12), and on a fork running DC on
// LIMS, LIMS status names. Plus a draft (no status) and a string nothing knows.
const STATUSES = [
  'Introduced', '12', 'Engrossed', '8', 'Pre-filed', '11', 'Passed', '9', 'Vetoed', '10',
  'Enrolled', '7', 'Failed', 'Under Mayoral Review', 'Official Law', 'Deemed Approved', '', 'Pending',
]

// The status sort before 0076, verbatim.
const OLD_STATUS_SORT = `CASE status WHEN '12' THEN 1 WHEN 'Pre-filed' THEN 2 WHEN 'Introduced' THEN 3 WHEN '9' THEN 4 WHEN '11' THEN 5 WHEN '10' THEN 6 WHEN 'Engrossed' THEN 7 WHEN 'Enrolled' THEN 8 WHEN 'Failed' THEN 9 WHEN 'Vetoed' THEN 10 WHEN 'Passed' THEN 11 WHEN '7' THEN 12 WHEN '8' THEN 13 ELSE 0 END`

const LEGISCAN = new Set(['Introduced', '12', 'Engrossed', '8', 'Pre-filed', '11', 'Passed', '9', 'Vetoed', '10', 'Enrolled', '7', 'Failed'])

describe('0076_bill_status_stage', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0076' })
    const insert = env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, status) VALUES (?, ?, ?, 'RI', ?)`)
    await env.DB.batch(STATUSES.map((status, i) => insert.bind(`b${i}`, `HB ${i}`, `Bill ${i}`, status)))
    await applyMigrations()
  })

  async function byStatus(): Promise<Map<string, { stage: string | null; rank: number }>> {
    const { results } = await env.DB.prepare(`SELECT status, status_stage, status_rank FROM bills`)
      .all<{ status: string; status_stage: string | null; status_rank: number }>()
    return new Map(results.map(r => [r.status, { stage: r.status_stage, rank: r.status_rank }]))
  }

  it('gives LegiScan labels and codes the stage and rank central sends', async () => {
    const rows = await byStatus()
    expect(rows.get('12')).toEqual({ stage: 'introduced', rank: 101 })
    expect(rows.get('Introduced')).toEqual({ stage: 'introduced', rank: 103 })
    expect(rows.get('9')).toEqual({ stage: 'in_committee', rank: 201 })
    expect(rows.get('Engrossed')).toEqual({ stage: 'passed_one_chamber', rank: 301 })
    expect(rows.get('Enrolled')).toEqual({ stage: 'passed', rank: 401 })
    expect(rows.get('Failed')).toEqual({ stage: 'failed', rank: 501 })
    expect(rows.get('Vetoed')).toEqual({ stage: 'vetoed', rank: 601 })
    expect(rows.get('Passed')).toEqual({ stage: 'enacted', rank: 701 })
    expect(rows.get('8')).toEqual({ stage: 'enacted', rank: 703 })
  })

  it('keeps the LegiScan status sort in the same order', async () => {
    const order = async (by: string) => (await env.DB.prepare(`SELECT status FROM bills ORDER BY ${by}, id`)
      .all<{ status: string }>()).results.map(r => r.status).filter(s => LEGISCAN.has(s))
    expect(await order('status_rank')).toEqual(await order(OLD_STATUS_SORT))
  })

  it('stages DC\'s LIMS statuses on a fork that has them', async () => {
    const rows = await byStatus()
    expect(rows.get('Under Mayoral Review')).toEqual({ stage: 'passed', rank: 401 })
    expect(rows.get('Deemed Approved')).toEqual({ stage: 'enacted', rank: 702 })
    expect(rows.get('Official Law')).toEqual({ stage: 'enacted', rank: 705 })
  })

  it('leaves a draft and an unknown status with no stage, sorting below every known status', async () => {
    const rows = await byStatus()
    expect(rows.get('')).toEqual({ stage: null, rank: 0 })
    expect(rows.get('Pending')).toEqual({ stage: null, rank: 0 })
  })
})
