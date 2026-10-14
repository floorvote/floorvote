import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0100 adds each bill's companion group key, the identical relationships it is
// computed from, and the team events grouping writes. It runs over an
// instance's existing bills, which start ungrouped until their next delivery
// from central.
describe('migration 0100: companion groups', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0100_companion_groups' })
    // Raw SQL, since the app's schema already names the column this adds.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO bills (id, bill_number, title, state, external_id) VALUES ('a190', 'A190', 't', 'NJ', 'legiscan:190')"),
      env.DB.prepare("INSERT INTO bills (id, bill_number, title, state, external_id) VALUES ('b1713', 'S1713', 't', 'NJ', 'legiscan:1713')"),
    ])
    await applyMigrations()
  })

  it('leaves existing bills ungrouped', async () => {
    const { results } = await env.DB.prepare('SELECT id, group_key FROM bills ORDER BY id').all<{ id: string; group_key: string | null }>()
    expect(results).toEqual([{ id: 'a190', group_key: null }, { id: 'b1713', group_key: null }])
  })

  it("reads a group's members through the group key index", async () => {
    const { results } = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT id FROM bills WHERE group_key = ?')
      .bind('a190').all<{ detail: string }>()
    const plan = results.map(r => r.detail).join('\n')
    expect(plan, plan).toContain('idx_bills_group_key')
  })

  it('reads the bills naming a companion through the reverse index', async () => {
    const { results } = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT external_id FROM bill_identical_links WHERE companion_external_id = ?',
    ).bind('legiscan:190').all<{ detail: string }>()
    const plan = results.map(r => r.detail).join('\n')
    expect(plan, plan).toContain('idx_bill_identical_links_companion')
  })

  it('reads a bill\'s team events through their index', async () => {
    const { results } = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM team_events WHERE bill_id = ? ORDER BY created_at',
    ).bind('a190').all<{ detail: string }>()
    const plan = results.map(r => r.detail).join('\n')
    expect(plan, plan).toContain('idx_team_events_bill')
    expect(plan, plan).not.toContain('TEMP B-TREE')
  })

  it('analyzes the new index so the planner has its statistics', async () => {
    const row = await env.DB.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_bills_group_key'").first<{ stat: string }>()
    expect(row?.stat).toBeTruthy()
  })
})
