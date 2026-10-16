import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0103 stores each bill's group tags (#537): the tags of its companion group's
// current analysis, the most recently analyzed bill's, or its own for a bill in
// no group. A tag filter then tests one column per bill, as before groups. The
// migration fills them in for the groups an instance already has, and keeps
// them right from then on, whichever write changes a group or an analysis.

async function groupTags(): Promise<Record<string, string[]>> {
  const { results } = await env.DB.prepare('SELECT id, group_tags FROM bills ORDER BY id').all<{ id: string; group_tags: string }>()
  return Object.fromEntries(results.map(r => [r.id, JSON.parse(r.group_tags) as string[]]))
}

describe('migration 0103: group tags', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0103_group_tags' })
    // Bills as 0102 leaves them, some already grouped.
    await env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, status, session, tags, tenant_summary, ai_processed_at, group_key) VALUES
      ('solo', 'HB1', 't', 'NJ', 'Introduced', 's', '["Energy"]', 'x', '2026-01-01 00:00:00', NULL),
      ('bare', 'HB2', 't', 'NJ', 'Introduced', 's', '[]', NULL, NULL, NULL),
      ('g1a', 'HB3', 't', 'NJ', 'Introduced', 's', '["Labor"]', 'x', '2026-01-01 00:00:00', 'g1a'),
      ('g1b', 'HB4', 't', 'NJ', 'Introduced', 's', '["Energy","Housing"]', 'x', '2026-02-01 00:00:00', 'g1a'),
      ('g1c', 'HB5', 't', 'NJ', 'Introduced', 's', '[]', NULL, NULL, 'g1a'),
      ('g2a', 'HB6', 't', 'NJ', 'Introduced', 's', '[]', 'newer, with no tags', '2026-03-01 00:00:00', 'g2a'),
      ('g2b', 'HB7', 't', 'NJ', 'Introduced', 's', '["Labor"]', 'x', '2026-01-01 00:00:00', 'g2a'),
      ('g3a', 'HB8', 't', 'NJ', 'Introduced', 's', '[]', NULL, NULL, 'g3a'),
      ('g3b', 'HB9', 't', 'NJ', 'Introduced', 's', '[]', NULL, NULL, 'g3a'),
      ('g4a', 'HB10', 't', 'NJ', 'Introduced', 's', '["Labor"]', 'x', '2026-01-01 00:00:00', 'g4a'),
      ('g4b', 'HB11', 't', 'NJ', 'Introduced', 's', '["Water"]', 'x', '2026-01-01 00:00:00', 'g4a')`).run()
    await applyMigrations()
  })

  it("stores each grouped bill's group tags from its group's current analysis", async () => {
    const tags = await groupTags()
    // The most recently analyzed bill's tags, on every bill of the group.
    expect([tags.g1a, tags.g1b, tags.g1c]).toEqual([['Energy', 'Housing'], ['Energy', 'Housing'], ['Energy', 'Housing']])
    // A newer analysis with no tags replaces older tags: a stale tag never matches.
    expect([tags.g2a, tags.g2b]).toEqual([[], []])
    // A group with no analysis has none.
    expect([tags.g3a, tags.g3b]).toEqual([[], []])
    // Analyzed at the same moment: the larger id, as the group's other reads break the tie.
    expect([tags.g4a, tags.g4b]).toEqual([['Water'], ['Water']])
  })

  it('stores the own tags of a bill in no group', async () => {
    const tags = await groupTags()
    expect([tags.solo, tags.bare]).toEqual([['Energy'], []])
  })

  it("follows the group when a bill is added to it, or the bill holding its analysis leaves it", async () => {
    await env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, status, session, tags, tenant_summary, ai_processed_at, group_key)
      VALUES ('g3c', 'HB12', 't', 'NJ', 'Introduced', 's', '["Housing"]', 'x', '2026-04-01 00:00:00', 'g3a')`).run()
    await env.DB.prepare("DELETE FROM bills WHERE id = 'g1b'").run()
    const tags = await groupTags()
    expect([tags.g3a, tags.g3b, tags.g3c]).toEqual([['Housing'], ['Housing'], ['Housing']])
    expect([tags.g1a, tags.g1c]).toEqual([['Labor'], ['Labor']])
  })

  it('indexes the bills with group tags, and only those', async () => {
    const { results } = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_bills_group_tags'").all<{ sql: string }>()
    expect(results).toHaveLength(1)
    expect(results[0].sql).toMatch(/WHERE group_tags <> '\[\]'/)
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bills INDEXED BY idx_bills_group_tags WHERE group_tags <> '[]'").first<{ n: number }>()
    expect(row?.n).toBe(6)
  })

  it('analyzes the index so the planner has its statistics', async () => {
    const row = await env.DB.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_bills_group_tags'").first<{ stat: string }>()
    expect(row?.stat).toBeTruthy()
  })
})
