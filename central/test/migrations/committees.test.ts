import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'
import { app } from '../../src/index-legiscan'

// A central upgrading onto committees (#299): built from the migrations before
// 0035, holding LegiScan bills whose referrals carry LegiScan's committee ids
// and a DC LIMS bill whose referrals carry none, then migrated. Checked
// through the bill API, with no ingest in between.

const before0035: MigrationFiles = Object.fromEntries(
  Object.entries(legiscanMigrations).filter(([path]) => path.split('/').pop()! < '0035'))

const SECRET = 'test-secret'
const getBill = async (id: number) => {
  const res = await app.fetch(new Request(`http://central/api/bills/legiscan:${id}`, { headers: { 'x-admin-secret': SECRET } }), { ...(env as any), ADMIN_SECRET: SECRET })
  expect(res.status).toBe(200)
  return res.json() as Promise<any>
}

beforeEach(async () => {
  await setupDb(before0035)
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO bills (bill_id, change_hash, session_id, state, state_id, bill_number, title, pending_committee_id, provider) VALUES
      (9001, 'h', 2154, 'WI', 50, 'AB1', 'AB 1', 7001, 'legiscan'),
      (9002, 'h', 2154, 'WI', 50, 'AB2', 'AB 2', NULL, 'legiscan'),
      (1012600400, 'h', 1000000026, 'DC', 51, 'B26-0400', 'B26-0400', NULL, 'lims')`),
    env.DB.prepare(`INSERT INTO bill_referrals (id, bill_id, date, committee_id, chamber, chamber_id, name) VALUES
      ('r1', 9001, '2026-01-16', 7001, 'A', 26, 'Elections'),
      ('r2', 9001, '2026-02-03', 7002, 'S', 27, 'Judiciary'),
      ('r3', 9002, '2026-03-01', 7001, 'A', 26, 'Campaigns and Elections'),
      ('r4', 9002, '2026-03-02', NULL, 'A', 26, 'Rules'),
      ('r5', 1012600400, '2025-10-07', NULL, 'C', 0, 'Youth Affairs')`),
  ])
  await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
})

describe('committees on an upgraded central', () => {
  it('fill from the referrals LegiScan bills already hold, each named by its latest referral', async () => {
    const ab1 = await getBill(9001)
    expect(ab1.committee).toEqual({ committeeId: '7001', name: 'Campaigns and Elections', chamber: 'A' })
    expect(ab1.referrals).toEqual([
      { date: '2026-01-16', committeeId: '7001', name: 'Campaigns and Elections', chamber: 'A' },
      { date: '2026-02-03', committeeId: '7002', name: 'Judiciary', chamber: 'S' },
    ])
    expect((await getBill(9002)).referrals).toEqual([
      { date: '2026-03-01', committeeId: '7001', name: 'Campaigns and Elections', chamber: 'A' },
      { date: '2026-03-02', committeeId: null, name: 'Rules', chamber: 'A' },
    ])

    const rows = (await env.DB.prepare('SELECT committee_id, state, session_id, provider FROM committees ORDER BY committee_id').all()).results
    expect(rows).toEqual([
      { committee_id: 7001, state: 'WI', session_id: 2154, provider: 'legiscan' },
      { committee_id: 7002, state: 'WI', session_id: 2154, provider: 'legiscan' },
    ])
  })

  it('leave a referral with no committee id as it was, naming no committee', async () => {
    expect((await getBill(1012600400)).referrals).toEqual([{ date: '2025-10-07', committeeId: null, name: 'Youth Affairs', chamber: 'C' }])
  })
})
