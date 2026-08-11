import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'

/**
 * Everything in demoSeeds.lakeMichigan.test.ts proves the seed is internally
 * consistent as a TypeScript object. None of it proves D1 accepts the rows: the
 * `INSERT ... SELECT ... WHERE (SELECT id FROM bills WHERE external_id = ?) IS
 * NOT NULL` guards the machinery uses mean a dangling id produces zero rows
 * silently, not an error. A table count that comes up short is the only way that
 * class of bug surfaces — hence a real resetDb() / applyMigrations() /
 * runDemoReset() round trip here, against real D1 bindings.
 */
const seed = DEMO_SEEDS['lake-michigan']
const count = async (t: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0

describe('runDemoReset with the lake-michigan seed', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    // Every bill the seed references must exist, or its INSERT ... SELECT guards
    // no-op instead of failing loudly. priority: null so the "every bill has a
    // priority" test below proves the RESET set it, not the fixture.
    for (const [i, p] of seed.priorities.entries()) {
      await seedBill({
        externalId: p.externalId, billNumber: `B${1000 + i}`, title: `Bill ${i}`,
        state: 'MI', priority: null,
      })
    }
  })

  it('installs the roster and static data', async () => {
    await runDemoReset(env.DB, seed)
    expect(await count('users')).toBe(seed.users.length)
    expect(await count('roles')).toBe(seed.roles.length)
    expect(await count('custom_field_definitions')).toBe(seed.customFields.length)
    // One session and one used magic link per persona (Step 3b/3c of demoReset.ts) —
    // without these the sidebar member count and active-member stats read as empty
    // despite the full seeded roster.
    expect(await count('sessions')).toBe(seed.users.length)
    expect(await count('magic_links')).toBe(seed.users.length)
  })

  it('installs the engagement data', async () => {
    await runDemoReset(env.DB, seed)
    expect(await count('comments')).toBe(seed.comments.length)
    expect(await count('comment_reactions')).toBe(seed.reactions.length)
    expect(await count('comment_mentions')).toBe(seed.mentions.length)
    expect(await count('member_votes')).toBe(seed.votes.length)
    expect(await count('official_positions')).toBe(seed.positions.length)
    expect(await count('bill_custom_field_values')).toBe(seed.customFieldValues.length)
    expect(await count('feed_events')).toBe(seed.feedEvents.length)
    expect(await count('calendar_events')).toBe(seed.calendarEvents.length)
    expect(await count('notes')).toBe(seed.notes.length)
  })

  // The brief's own list catches a total miscount, but reports it as a bare
  // "expected X, got Y" — this pins the same five categories with the delta
  // spelled out in the failure message, which is what actually tells you how
  // many ids went dangling.
  it('drops no comment, reaction, mention, vote, or note through the bill guard', async () => {
    await runDemoReset(env.DB, seed)
    const checks: Array<[table: string, expected: number]> = [
      ['comments', seed.comments.length],
      ['comment_reactions', seed.reactions.length],
      ['comment_mentions', seed.mentions.length],
      ['member_votes', seed.votes.length],
      ['notes', seed.notes.length],
    ]
    for (const [table, expected] of checks) {
      const actual = await count(table)
      expect(actual, `${table}: expected ${expected}, got ${actual} (delta ${actual - expected})`).toBe(expected)
    }
  })

  it('gives every bill a priority', async () => {
    await runDemoReset(env.DB, seed)
    const row = await env.DB.prepare('SELECT count(*) AS n FROM bills WHERE priority IS NULL').first<{ n: number }>()
    expect(row!.n).toBe(0)
    const total = await env.DB.prepare('SELECT count(*) AS n FROM bills').first<{ n: number }>()
    expect(total!.n).toBe(seed.priorities.length)
  })

  it('writes the multi-state coverage and no instance_preset', async () => {
    expect(seed.stateCoverage).not.toBeNull()
    await runDemoReset(env.DB, seed)
    const cov = await env.DB.prepare(`SELECT value FROM association_config WHERE key = 'state_coverage'`).first<{ value: string }>()
    expect(cov, 'state_coverage row must exist for a multi-state seed').toBeDefined()
    expect(JSON.parse(cov!.value)).toEqual(seed.stateCoverage)
    expect(await env.DB.prepare(`SELECT value FROM association_config WHERE key = 'instance_preset'`).first()).toBeNull()
  })

  it('resolves role mentions to real user rows', async () => {
    await runDemoReset(env.DB, seed)
    const { results } = await env.DB.prepare(
      `SELECT cm.user_id FROM comment_mentions cm WHERE cm.source_type = 'role'`
    ).all()
    expect(results.length).toBeGreaterThan(0)
    const ids = new Set(seed.users.map(u => u.id))
    for (const r of results as Array<{ user_id: string }>) expect(ids.has(r.user_id)).toBe(true)
  })

  it('is idempotent', async () => {
    await runDemoReset(env.DB, seed)
    await runDemoReset(env.DB, seed)
    expect(await count('users')).toBe(seed.users.length)
    expect(await count('comments')).toBe(seed.comments.length)
    expect(await count('comment_reactions')).toBe(seed.reactions.length)
    expect(await count('comment_mentions')).toBe(seed.mentions.length)
    expect(await count('member_votes')).toBe(seed.votes.length)
    expect(await count('feed_events')).toBe(seed.feedEvents.length)
    const row = await env.DB.prepare('SELECT count(*) AS n FROM bills WHERE priority IS NULL').first<{ n: number }>()
    expect(row!.n).toBe(0)
    const cov = await env.DB.prepare(`SELECT value FROM association_config WHERE key = 'state_coverage'`).first<{ value: string }>()
    expect(JSON.parse(cov!.value)).toEqual(seed.stateCoverage)
  })
})
