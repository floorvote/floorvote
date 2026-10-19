import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0106 makes a group's tags follow its tracked bill's analysis (#554), as
// lib/teamFields.ts reads the group's analysis for the bill page: among the
// members with an analysis, those with a match type come first, and the most
// recent of those wins, the larger id breaking a tie. Only a group with no
// tracked analysis takes the most recent of any member. A bill that starts or
// stops matching on its own moves its group's tags.

// 0113 replaced these triggers with ones that follow the group's lead bill
// (groupLeadAnalysis.test.ts), so these tests stop before it.
const UP_TO_0106 = { before: '0113_group_lead_analysis' }

async function groupTags(): Promise<Record<string, string[]>> {
  const { results } = await env.DB.prepare('SELECT id, group_tags FROM bills ORDER BY id').all<{ id: string; group_tags: string }>()
  return Object.fromEntries(results.map(r => [r.id, JSON.parse(r.group_tags) as string[]]))
}

async function run(sql: string, ...binds: unknown[]) {
  await env.DB.prepare(sql).bind(...binds).run()
}

const insertSql = `INSERT INTO bills (id, bill_number, title, state, status, session, tags, tenant_summary, ai_processed_at, match_type, group_key)
  VALUES (?, ?, 't', 'NJ', 'Introduced', 's', ?, ?, ?, ?, ?)`

type Fixture = { id: string; tags: string[]; summary: string | null; at: string | null; match: 'keyword' | 'manual' | null; key: string | null }

async function insert(f: Fixture) {
  await run(insertSql, f.id, f.id.toUpperCase(), JSON.stringify(f.tags), f.summary, f.at, f.match, f.key)
}

describe('migration 0106: a group\'s tags follow its tracked bill', () => {
  describe('existing groups', () => {
    beforeEach(async () => {
      await resetDb()
      await applyMigrations({ before: '0106_tracked_group_analysis' })
      // Groups as 0103 leaves them: the most recently analyzed bill's tags, tracked or not.
      for (const f of [
        // A pulled companion analyzed after the tracked bill.
        { id: 'p1a', tags: ['Labor'], summary: 'x', at: '2026-09-01 00:00:00', match: 'keyword', key: 'p1a' },
        { id: 'p1b', tags: ['Energy'], summary: 'x', at: '2026-09-05 00:00:00', match: null, key: 'p1a' },
        // Two tracked bills and a newer pulled one: the newer tracked.
        { id: 'p2a', tags: ['Labor'], summary: 'x', at: '2026-09-01 00:00:00', match: 'keyword', key: 'p2a' },
        { id: 'p2b', tags: ['Housing'], summary: 'x', at: '2026-09-03 00:00:00', match: 'manual', key: 'p2a' },
        { id: 'p2c', tags: ['Energy'], summary: 'x', at: '2026-09-05 00:00:00', match: null, key: 'p2a' },
        // No tracked analysis: the most recent of any.
        { id: 'p3a', tags: [], summary: null, at: null, match: 'keyword', key: 'p3a' },
        { id: 'p3b', tags: ['Labor'], summary: 'x', at: '2026-09-01 00:00:00', match: null, key: 'p3a' },
        { id: 'p3c', tags: ['Energy'], summary: 'x', at: '2026-09-03 00:00:00', match: null, key: 'p3a' },
        // A tie between tracked bills: the larger id.
        { id: 'p4a', tags: ['Labor'], summary: 'x', at: '2026-09-01 00:00:00', match: 'keyword', key: 'p4a' },
        { id: 'p4b', tags: ['Water'], summary: 'x', at: '2026-09-01 00:00:00', match: 'keyword', key: 'p4a' },
        { id: 'p4c', tags: ['Energy'], summary: 'x', at: '2026-09-09 00:00:00', match: null, key: 'p4a' },
        // In no group: its own, tracked or not.
        { id: 'solo', tags: ['Energy'], summary: 'x', at: '2026-09-01 00:00:00', match: null, key: null },
      ] satisfies Fixture[]) await insert(f)
      const before = await groupTags()
      // What this migration changes: 0103 gave the pulled companion's tags.
      expect(before.p1a).toEqual(['Energy'])
      await applyMigrations(UP_TO_0106)
    })

    it('stores the tracked bill\'s tags over a newer pulled companion\'s', async () => {
      const tags = await groupTags()
      expect([tags.p1a, tags.p1b]).toEqual([['Labor'], ['Labor']])
    })

    it('stores the most recent tracked bill\'s tags when two are tracked', async () => {
      const tags = await groupTags()
      expect([tags.p2a, tags.p2b, tags.p2c]).toEqual([['Housing'], ['Housing'], ['Housing']])
    })

    it('stores the most recent of any when no tracked bill has an analysis', async () => {
      const tags = await groupTags()
      expect([tags.p3a, tags.p3b, tags.p3c]).toEqual([['Energy'], ['Energy'], ['Energy']])
    })

    it('breaks a tie between tracked bills by the larger id', async () => {
      const tags = await groupTags()
      expect([tags.p4a, tags.p4b, tags.p4c]).toEqual([['Water'], ['Water'], ['Water']])
    })

    it('changes no other group, and leaves a bill in no group its own tags', async () => {
      const tags = await groupTags()
      expect([tags.p1a, tags.solo]).toEqual([['Labor'], ['Energy']])
    })
  })

  describe('triggers', () => {
    beforeEach(async () => {
      await resetDb()
      await applyMigrations(UP_TO_0106)
      // A190 is tracked and analyzed first. S1713 is a pulled companion analyzed later.
      await insert({ id: 'a190', tags: ['Labor'], summary: 'A190 summary', at: '2026-09-01 00:00:00', match: 'keyword', key: 'a190' })
      await insert({ id: 'b1713', tags: ['Energy'], summary: 'S1713 summary', at: '2026-09-05 00:00:00', match: null, key: 'a190' })
    })

    it('keeps the tracked bill\'s tags when the pulled companion joins with a newer analysis', async () => {
      const tags = await groupTags()
      expect([tags.a190, tags.b1713]).toEqual([['Labor'], ['Labor']])
    })

    it('keeps them when the pulled companion is analyzed again', async () => {
      await run("UPDATE bills SET tags = '[\"Water\"]', ai_processed_at = '2026-09-09 00:00:00' WHERE id = 'b1713'")
      const tags = await groupTags()
      expect([tags.a190, tags.b1713]).toEqual([['Labor'], ['Labor']])
    })

    it('moves to the companion when it starts matching on its own, with nothing else changed', async () => {
      expect((await groupTags()).a190).toEqual(['Labor'])
      await run("UPDATE bills SET match_type = 'keyword' WHERE id = 'b1713'")
      const tags = await groupTags()
      expect([tags.a190, tags.b1713]).toEqual([['Energy'], ['Energy']])
    })

    it('moves to the companion when it is added by hand', async () => {
      expect((await groupTags()).a190).toEqual(['Labor'])
      await run("UPDATE bills SET match_type = 'manual' WHERE id = 'b1713'")
      expect((await groupTags()).a190).toEqual(['Energy'])
    })

    it('falls back to the companion when the tracked bill stops matching, leaving no tracked analysis', async () => {
      expect((await groupTags()).a190).toEqual(['Labor'])
      await run("UPDATE bills SET match_type = NULL WHERE id = 'a190'")
      const tags = await groupTags()
      expect([tags.a190, tags.b1713]).toEqual([['Energy'], ['Energy']])
    })

    it('moves from a bill that stops matching to the other tracked bill', async () => {
      await insert({ id: 'c9', tags: ['Housing'], summary: 'x', at: '2026-09-03 00:00:00', match: 'keyword', key: 'a190' })
      expect((await groupTags()).a190).toEqual(['Housing'])
      await run("UPDATE bills SET match_type = NULL WHERE id = 'c9'")
      expect((await groupTags()).a190).toEqual(['Labor'])
    })

    it('falls back to the pulled companion when the tracked bill is deleted', async () => {
      expect((await groupTags()).b1713).toEqual(['Labor'])
      await run("DELETE FROM bills WHERE id = 'a190'")
      expect((await groupTags()).b1713).toEqual(['Energy'])
    })

    it('gives each bill its own tags back when the group splits', async () => {
      expect((await groupTags()).b1713).toEqual(['Labor'])
      await run("UPDATE bills SET group_key = NULL WHERE id IN ('a190', 'b1713')")
      const tags = await groupTags()
      expect([tags.a190, tags.b1713]).toEqual([['Labor'], ['Energy']])
    })

    it('falls back to the pulled companion when the tracked bill leaves the group', async () => {
      await insert({ id: 'c9', tags: [], summary: null, at: null, match: null, key: 'a190' })
      expect((await groupTags()).c9).toEqual(['Labor'])
      await run("UPDATE bills SET group_key = NULL WHERE id = 'a190'")
      const tags = await groupTags()
      expect([tags.a190, tags.b1713, tags.c9]).toEqual([['Labor'], ['Energy'], ['Energy']])
    })

    it('doesn\'t write group tags when a bill in no group changes match type', async () => {
      await insert({ id: 'solo', tags: ['Water'], summary: 'x', at: '2026-09-01 00:00:00', match: 'keyword', key: null })
      // A marker the trigger would overwrite with the bill's own tags if it ran. Writing group_tags alone fires none.
      await run("UPDATE bills SET group_tags = '[\"marker\"]' WHERE id = 'solo'")
      await run("UPDATE bills SET match_type = NULL WHERE id = 'solo'")
      expect((await groupTags()).solo).toEqual(['marker'])
      await run("UPDATE bills SET match_type = 'manual' WHERE id = 'solo'")
      expect((await groupTags()).solo).toEqual(['marker'])
    })

    it('still recomputes a bill in no group when its own tags change', async () => {
      await insert({ id: 'solo', tags: ['Water'], summary: 'x', at: '2026-09-01 00:00:00', match: 'keyword', key: null })
      await run("UPDATE bills SET group_tags = '[\"marker\"]' WHERE id = 'solo'")
      await run("UPDATE bills SET tags = '[\"Housing\"]', match_type = NULL WHERE id = 'solo'")
      expect((await groupTags()).solo).toEqual(['Housing'])
    })

    it('recomputes the old group when a bill leaves it and changes match type in one write', async () => {
      await run("UPDATE bills SET group_key = NULL, match_type = NULL WHERE id = 'a190'")
      const tags = await groupTags()
      expect([tags.a190, tags.b1713]).toEqual([['Labor'], ['Energy']])
    })

    it('takes a newly tracked bill\'s newer analysis when it joins', async () => {
      await insert({ id: 'c9', tags: ['Housing'], summary: 'x', at: '2026-09-03 00:00:00', match: 'keyword', key: 'a190' })
      const tags = await groupTags()
      expect([tags.a190, tags.b1713, tags.c9]).toEqual([['Housing'], ['Housing'], ['Housing']])
    })

  })
})
