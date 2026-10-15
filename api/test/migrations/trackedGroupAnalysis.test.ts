import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { loadTeamValuesOf } from '../../src/lib/teamFields'

// 0106 makes a group's tags follow its tracked bill's analysis (#554), as
// lib/teamFields.ts reads the group's analysis for the bill page: among the
// members with an analysis, those with a match type come first, and the most
// recent of those wins, the larger id breaking a tie. Only a group with no
// tracked analysis takes the most recent of any member. A bill that starts or
// stops matching on its own moves its group's tags.

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
      await applyMigrations()
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
      await applyMigrations()
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

    it('takes a newly tracked bill\'s newer analysis when it joins', async () => {
      await insert({ id: 'c9', tags: ['Housing'], summary: 'x', at: '2026-09-03 00:00:00', match: 'keyword', key: 'a190' })
      const tags = await groupTags()
      expect([tags.a190, tags.b1713, tags.c9]).toEqual([['Housing'], ['Housing'], ['Housing']])
    })

  })

  describe('the triggers and lib/teamFields.ts agree', () => {
    // Every bill's group tags are the tags of the analysis the bill page reads for it,
    // after each of a long run of random writes: analyses, clears, match type changes,
    // group moves, inserts, and deletes. Times come from a short list, so ties are common.

    function prng(seed: number) {
      let s = seed >>> 0
      return () => {
        s = (s + 0x6d2b79f5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    type Raw = { id: string; tags: string; tenant_summary: string | null; ai_processed_at: string | null; match_type: string | null; group_key: string | null }

    /** The rule, written out here as the ticket states it, from the raw rows. */
    function byRule(rows: Raw[], id: string, trackedFirst: boolean): string[] {
      const me = rows.find(r => r.id === id)!
      if (me.group_key === null) return JSON.parse(me.tags) as string[]
      const analyzed = rows.filter(r => r.group_key === me.group_key && (r.ai_processed_at !== null || r.tenant_summary !== null || r.tags !== '[]'))
      const tracked = analyzed.filter(r => r.match_type !== null)
      const pool = trackedFirst && tracked.length > 0 ? tracked : analyzed
      const best = [...pool].sort((a, b) => (b.ai_processed_at ?? '').localeCompare(a.ai_processed_at ?? '') || b.id.localeCompare(a.id))[0]
      return best ? JSON.parse(best.tags) as string[] : []
    }

    /** How many times a bill's group showed a different analysis than plain most-recent would: the rule at work. */
    let differed = 0

    async function expectAgreement(step: string) {
      const stored = await groupTags()
      const read = await loadTeamValuesOf(getDb(env.DB), Object.keys(stored))
      const fromTs = Object.fromEntries(Object.keys(stored).map(id => [id, read.get(id)?.analysis?.tags ?? []]))
      expect(stored, `${step}: group_tags against lib/teamFields.ts`).toEqual(fromTs)
      const { results: raw } = await env.DB.prepare('SELECT id, tags, tenant_summary, ai_processed_at, match_type, group_key FROM bills').all<Raw>()
      const fromRule = Object.fromEntries(Object.keys(stored).map(id => [id, byRule(raw, id, true)]))
      expect(fromTs, `${step}: lib/teamFields.ts against the rule`).toEqual(fromRule)
      differed += Object.keys(stored).filter(id => JSON.stringify(byRule(raw, id, true)) !== JSON.stringify(byRule(raw, id, false))).length
    }

    for (const seed of [1, 2, 3, 4]) {
      it(`agrees on every bill after each write (seed ${seed})`, async () => {
        await resetDb()
        await applyMigrations()
        differed = 0
        const rnd = prng(seed)
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
        const TIMES = [null, '2026-09-01 00:00:00', '2026-09-02 00:00:00', '2026-09-03 00:00:00'] as const
        const MATCH = [null, null, 'keyword', 'manual'] as const
        const KEYS = [null, 'g1', 'g1', 'g2', 'g2', 'g3'] as const
        let n = 0
        const analysis = () => {
          n += 1
          const at = pick(TIMES)
          const tags = rnd() < 0.25 ? [] : [`t${n}`]
          // An analysis is a time, a summary, or tags. Keep at least one.
          const summary = at === null && tags.length === 0 ? `s${n}` : rnd() < 0.8 ? `s${n}` : null
          return { tags, summary, at }
        }
        const ids: string[] = []
        for (let i = 0; i < 12; i++) {
          const id = `b${String(i).padStart(2, '0')}`
          const a = rnd() < 0.7 ? analysis() : { tags: [], summary: null, at: null }
          await insert({ id, ...a, match: pick(MATCH), key: pick(KEYS) })
          ids.push(id)
        }
        await expectAgreement('seeded')
        for (let step = 0; step < 40; step++) {
          const id = pick(ids)
          const r = rnd()
          if (r < 0.25) {
            const a = analysis()
            await run('UPDATE bills SET tags = ?, tenant_summary = ?, ai_processed_at = ? WHERE id = ?', JSON.stringify(a.tags), a.summary, a.at, id)
          } else if (r < 0.3) {
            await run("UPDATE bills SET tags = '[]', tenant_summary = NULL, ai_processed_at = NULL WHERE id = ?", id)
          } else if (r < 0.6) {
            await run('UPDATE bills SET match_type = ? WHERE id = ?', pick(MATCH), id)
          } else if (r < 0.85) {
            await run('UPDATE bills SET group_key = ? WHERE id = ?', pick(KEYS), id)
          } else if (r < 0.93) {
            const fresh = `n${step}`
            await insert({ id: fresh, ...analysis(), match: pick(MATCH), key: pick(KEYS) })
            ids.push(fresh)
          } else if (ids.length > 4) {
            await run('DELETE FROM bills WHERE id = ?', id)
            ids.splice(ids.indexOf(id), 1)
          }
          await expectAgreement(`seed ${seed}, step ${step}`)
        }
        // The run reached groups where the tracked rule and plain most-recent part ways.
        expect(differed).toBeGreaterThan(0)
      })
    }
  })
})
