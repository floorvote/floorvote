import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { LEGACY_STATUS_ORDER, LEGISCAN_CODE_WORDS } from '../../../shared/legacyStatusOrder'

// The status strings tenant bills can hold before 0076: LegiScan labels, bare
// LegiScan codes (7 to 12 from central, 0 to 6 in older data and the dev seed),
// the words central now sends for 7 to 12 (stored if central deploys first),
// and on a fork running DC on LIMS, LIMS status names. Plus a FloorVote draft
// (empty status) and a string nothing knows.
const STATUSES = [...Object.keys(LEGACY_STATUS_ORDER), '', 'Pending']

// The status sort before 0076, verbatim, and the strings it ranked.
const OLD_STATUS_SORT = `CASE status WHEN '12' THEN 1 WHEN 'Pre-filed' THEN 2 WHEN 'Introduced' THEN 3 WHEN '9' THEN 4 WHEN '11' THEN 5 WHEN '10' THEN 6 WHEN 'Engrossed' THEN 7 WHEN 'Enrolled' THEN 8 WHEN 'Failed' THEN 9 WHEN 'Vetoed' THEN 10 WHEN 'Passed' THEN 11 WHEN '7' THEN 12 WHEN '8' THEN 13 ELSE 0 END`
const OLD_SORTED = ['12', 'Pre-filed', 'Introduced', '9', '11', '10', 'Engrossed', 'Enrolled', 'Failed', 'Vetoed', 'Passed', '7', '8']

const idOf = (status: string) => `b${STATUSES.indexOf(status)}`

describe('0076_bill_status_stage', () => {
  let oldOrder: string[]

  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0076' })
    const insert = env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, status) VALUES (?, ?, ?, 'RI', ?)`)
    await env.DB.batch(STATUSES.map(status => insert.bind(idOf(status), `HB ${idOf(status)}`, 'Bill', status)))
    oldOrder = (await env.DB.prepare(`SELECT id FROM bills WHERE status IN (${OLD_SORTED.map(() => '?').join(', ')}) ORDER BY ${OLD_STATUS_SORT}, id`)
      .bind(...OLD_SORTED).all<{ id: string }>()).results.map(r => r.id)
    await applyMigrations()
  })

  async function rows(): Promise<Map<string, { status: string; stage: string | null; rank: number }>> {
    const { results } = await env.DB.prepare(`SELECT id, status, status_stage, status_rank FROM bills`)
      .all<{ id: string; status: string; status_stage: string | null; status_rank: number }>()
    return new Map(results.map(r => [r.id, { status: r.status, stage: r.status_stage, rank: r.status_rank }]))
  }

  it('backfills every string the shared table knows with its stage and rank', async () => {
    const after = await rows()
    for (const [status, { stage, rank }] of Object.entries(LEGACY_STATUS_ORDER)) {
      expect({ status, stage: after.get(idOf(status))!.stage, rank: after.get(idOf(status))!.rank }).toEqual({ status, stage, rank })
    }
  })

  it('gives LegiScan labels and codes the stage and rank central sends', async () => {
    const after = await rows()
    expect(after.get(idOf('12'))).toMatchObject({ stage: 'introduced', rank: 101 })
    expect(after.get(idOf('Introduced'))).toMatchObject({ stage: 'introduced', rank: 103 })
    expect(after.get(idOf('9'))).toMatchObject({ stage: 'in_committee', rank: 201 })
    expect(after.get(idOf('Engrossed'))).toMatchObject({ stage: 'passed_one_chamber', rank: 301 })
    expect(after.get(idOf('Enrolled'))).toMatchObject({ stage: 'passed', rank: 401 })
    expect(after.get(idOf('Failed'))).toMatchObject({ stage: 'failed', rank: 501 })
    expect(after.get(idOf('Vetoed'))).toMatchObject({ stage: 'vetoed', rank: 601 })
    expect(after.get(idOf('Passed'))).toMatchObject({ stage: 'enacted', rank: 701 })
    expect(after.get(idOf('Override'))).toMatchObject({ stage: 'enacted', rank: 702 })
    expect(after.get(idOf('8'))).toMatchObject({ stage: 'enacted', rank: 703 })
  })

  it('keeps the LegiScan status sort in the same order', async () => {
    const newOrder = (await env.DB.prepare(`SELECT id FROM bills WHERE id IN (${oldOrder.map(() => '?').join(', ')}) ORDER BY status_rank, id`)
      .bind(...oldOrder).all<{ id: string }>()).results.map(r => r.id)
    expect(newOrder).toEqual(oldOrder)
  })

  it('rewrites the bare codes 7 to 12 as the words central now sends, and leaves every other status alone', async () => {
    const after = await rows()
    for (const status of STATUSES) {
      expect(after.get(idOf(status))!.status).toBe(LEGISCAN_CODE_WORDS[status] ?? status)
    }
    expect(after.get(idOf('7'))!.status).toBe('Override')
    expect(after.get(idOf('2'))!.status).toBe('2')
  })

  it('stages DC\'s LIMS statuses on a fork that has them', async () => {
    const after = await rows()
    expect(after.get(idOf('Under Mayoral Review'))).toMatchObject({ stage: 'passed', rank: 401 })
    expect(after.get(idOf('Deemed Approved'))).toMatchObject({ stage: 'enacted', rank: 702 })
    expect(after.get(idOf('Official Law'))).toMatchObject({ stage: 'enacted', rank: 705 })
  })

  it('leaves a FloorVote draft and an unknown status with no stage, sorting below every known status', async () => {
    const after = await rows()
    expect(after.get(idOf(''))).toMatchObject({ stage: null, rank: 0 })
    expect(after.get(idOf('Pending'))).toMatchObject({ stage: null, rank: 0 })
  })
})
