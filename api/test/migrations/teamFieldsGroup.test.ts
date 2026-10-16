import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { bills } from '../../src/db/schema'
import { newMatchWhere } from '../../src/lib/newMatch'

// 0101 records when each bill's priority was set, so a companion group can
// read its priority from the member where it was set most recently. Existing
// priorities take the time of their latest priority feed event, from the bill
// or from a bulk edit that named it.
describe('migration 0101: team fields shared across a group', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0101_team_fields_group' })
    // Raw SQL, since the app's schema already names the column this adds.
    const bill = (id: string, priority: string | null) =>
      env.DB.prepare('INSERT INTO bills (id, bill_number, title, state, priority) VALUES (?, ?, ?, ?, ?)').bind(id, id.toUpperCase(), 't', 'NJ', priority)
    const event = (billId: string | null, metadata: object, createdAt: string) =>
      env.DB.prepare("INSERT INTO feed_events (id, type, bill_id, user_id, metadata, created_at) VALUES (?, 'priority_set', ?, 'u1', ?, ?)")
        .bind(crypto.randomUUID(), billId, JSON.stringify(metadata), createdAt)
    await env.DB.batch([
      bill('a1', 'high'),
      bill('a2', 'low'),
      bill('a3', 'medium'),
      bill('a4', null),
      event('a1', { priority: 'low' }, '2026-09-01 10:00:00'),
      event('a1', { priority: 'high' }, '2026-09-02 10:00:00'),
      event(null, { priority: 'low', count: 12, billIds: ['a2', 'a4'] }, '2026-09-03 10:00:00'),
      event('a4', { priority: 'high' }, '2026-09-04 10:00:00'),
    ])
    await applyMigrations()
  })

  it("checks a new match's companions for triage through the group key index", async () => {
    // The worklist predicate as the bill list and facets build it.
    const query = getDb(env.DB).select({ id: bills.id }).from(bills).where(newMatchWhere(0)).toSQL()
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.params).all<{ detail: string }>()
    const plan = results.map(r => r.detail).join('\n')
    expect(plan, plan).toMatch(/SEARCH t USING INDEX idx_bills_group_key/)
  })

  it("sets each existing priority's time from its latest priority event, bulk or not", async () => {
    const { results } = await env.DB.prepare('SELECT id, priority_set_at FROM bills ORDER BY id').all<{ id: string; priority_set_at: string | null }>()
    expect(results).toEqual([
      { id: 'a1', priority_set_at: '2026-09-02 10:00:00' },
      { id: 'a2', priority_set_at: '2026-09-03 10:00:00' },
      // A priority with no event, and a bill with no priority, have no time.
      { id: 'a3', priority_set_at: null },
      { id: 'a4', priority_set_at: null },
    ])
  })
})
