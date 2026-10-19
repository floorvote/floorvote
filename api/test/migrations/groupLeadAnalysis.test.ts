import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, parseMigration } from '../helpers'
import migration0113 from '../../migrations/0113_group_lead_analysis.sql?raw'
import { getDb } from '../../src/db/client'
import { loadTeamValuesOf } from '../../src/lib/teamFields'

// 0113 makes a group's tags follow its lead bill's analysis, as lib/teamFields.ts
// reads the group's analysis for every page: the lead is the bill furthest along,
// then the one with the newest text, then the lowest natural bill number, then
// the smallest id (lib/groupLead.ts). While the lead has no analysis, the group
// keeps 0106's rule: tracked first, then the most recent. Anything that can move
// the lead (a status, a bill number, a text added, removed, or redated) moves
// the group's tags. Invented bills throughout.

async function groupTags(): Promise<Record<string, string[]>> {
  const { results } = await env.DB.prepare('SELECT id, group_tags FROM bills ORDER BY id').all<{ id: string; group_tags: string }>()
  return Object.fromEntries(results.map(r => [r.id, JSON.parse(r.group_tags) as string[]]))
}

async function run(sql: string, ...binds: unknown[]) {
  await env.DB.prepare(sql).bind(...binds).run()
}

type Fixture = {
  id: string; number?: string; rank?: number; tags?: string[]; at?: string | null; match?: 'keyword' | 'manual' | null; key: string | null
  texts?: string[]
}

let docSeq = 1000
async function insert(f: Fixture) {
  const analyzed = f.at !== null
  await run(`INSERT INTO bills (id, bill_number, title, state, status, status_rank, session, tags, tenant_summary, ai_processed_at, match_type, group_key)
    VALUES (?, ?, 't', 'TX', 's', ?, 's', ?, ?, ?, ?, ?)`,
  f.id, f.number ?? f.id.toUpperCase(), f.rank ?? 100, JSON.stringify(f.tags ?? (analyzed ? [f.id] : [])),
  analyzed ? `${f.id} summary` : null, f.at === undefined ? '2026-09-01 00:00:00' : f.at, f.match === undefined ? 'keyword' : f.match, f.key)
  for (const date of f.texts ?? []) await text(f.id, date)
}

async function text(billId: string, date: string): Promise<string> {
  const docId = String(docSeq++)
  await run(`INSERT INTO bill_texts (id, bill_id, doc_id, type, date) VALUES (?, ?, ?, 'Introduced', ?)`, crypto.randomUUID(), billId, docId, date)
  return docId
}

describe('migration 0113: a group\'s tags follow its lead bill', () => {
  describe('existing groups', () => {
    beforeEach(async () => {
      await resetDb()
      await applyMigrations({ before: '0113_group_lead_analysis' })
      for (const f of [
        // Equally far along: q1b has the newer text and leads. q1a, tracked, was analyzed later.
        { id: 'q1a', at: '2026-09-05 00:00:00', key: 'q1a', texts: ['2026-01-01'] },
        { id: 'q1b', at: '2026-09-01 00:00:00', key: 'q1a', texts: ['2026-05-01'], match: null },
        // q2b is furthest along, though it has no text at all.
        { id: 'q2a', at: '2026-09-05 00:00:00', key: 'q2a', texts: ['2026-05-01'] },
        { id: 'q2b', rank: 300, at: '2026-09-01 00:00:00', key: 'q2a' },
        // The lead (q3b, furthest along) has no analysis: 0106's rule, the tracked bill.
        { id: 'q3a', at: '2026-09-01 00:00:00', key: 'q3a' },
        { id: 'q3b', rank: 300, at: null, key: 'q3a' },
        { id: 'q3c', at: '2026-09-05 00:00:00', key: 'q3a', match: null },
        // In no group: its own.
        { id: 'solo', at: '2026-09-01 00:00:00', key: null, match: null },
      ] satisfies Fixture[]) await insert(f)
      // What this migration changes: 0106 gave the most recent tracked bill's tags.
      expect((await groupTags()).q1b).toEqual(['q1a'])
      await applyMigrations()
    })

    it('stores the lead\'s tags, the bill with the newer text, over a more recent tracked analysis', async () => {
      const tags = await groupTags()
      expect([tags.q1a, tags.q1b]).toEqual([['q1b'], ['q1b']])
    })

    it('stores the tags of the bill furthest along, even with no text', async () => {
      const tags = await groupTags()
      expect([tags.q2a, tags.q2b]).toEqual([['q2b'], ['q2b']])
    })

    it('keeps 0106\'s rule while the lead has no analysis', async () => {
      const tags = await groupTags()
      expect([tags.q3a, tags.q3b, tags.q3c]).toEqual([['q3a'], ['q3a'], ['q3a']])
    })

    it('leaves a bill in no group its own tags', async () => {
      expect((await groupTags()).solo).toEqual(['solo'])
    })
  })

  describe('running it again', () => {
    // Wrangler records an applied migration and never runs it twice, but an
    // operator re-running the file by hand, or a partial apply retried, must
    // leave the same triggers and correct tags.
    const rerun = async () => {
      for (const q of parseMigration(migration0113, '0113_group_lead_analysis').queries) await env.DB.prepare(q).run()
    }

    beforeEach(async () => {
      await resetDb()
      await applyMigrations()
      await insert({ id: 'r1', number: 'HB10', at: '2026-09-05 00:00:00', key: 'r1', texts: ['2026-01-01'] })
      await insert({ id: 'r2', number: 'SB20', at: '2026-09-01 00:00:00', key: 'r1', texts: ['2026-03-01'] })
    })

    it('succeeds on a database that already has it, and keeps the lead\'s tags', async () => {
      await rerun()
      expect((await groupTags()).r1).toEqual(['r2'])
    })

    it('corrects group tags that drifted, and leaves every trigger working once', async () => {
      await run("UPDATE bills SET group_tags = '[\"stale\"]'")
      await rerun()
      const tags = await groupTags()
      expect([tags.r1, tags.r2]).toEqual([['r2'], ['r2']])
      const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%group_tags%' ORDER BY name").all<{ name: string }>()
      expect(results.map(r => r.name)).toEqual([
        'bill_texts_group_tags_delete', 'bill_texts_group_tags_insert', 'bill_texts_group_tags_update',
        'bills_group_tags_delete', 'bills_group_tags_insert', 'bills_group_tags_update',
      ])
      await text('r1', '2026-06-01')
      expect((await groupTags()).r2).toEqual(['r1'])
    })
  })

  describe('triggers', () => {
    beforeEach(async () => {
      await resetDb()
      await applyMigrations()
      // Equally far along and tracked. r2 has the newer text, so it leads. r1 was analyzed later.
      await insert({ id: 'r1', number: 'HB10', at: '2026-09-05 00:00:00', key: 'r1', texts: ['2026-01-01'] })
      await insert({ id: 'r2', number: 'SB20', at: '2026-09-01 00:00:00', key: 'r1', texts: ['2026-03-01'] })
    })

    it('stores the lead\'s tags when the group forms', async () => {
      const tags = await groupTags()
      expect([tags.r1, tags.r2]).toEqual([['r2'], ['r2']])
    })

    it('keeps them when the other member is analyzed again', async () => {
      await run("UPDATE bills SET tags = '[\"again\"]', ai_processed_at = '2026-09-09 00:00:00' WHERE id = 'r1'")
      expect((await groupTags()).r2).toEqual(['r2'])
    })

    it('moves to the other member when it gets a newer text', async () => {
      expect((await groupTags()).r1).toEqual(['r2'])
      await text('r1', '2026-06-01')
      const tags = await groupTags()
      expect([tags.r1, tags.r2]).toEqual([['r1'], ['r1']])
    })

    it('moves back when that text is removed', async () => {
      const docId = await text('r1', '2026-06-01')
      expect((await groupTags()).r2).toEqual(['r1'])
      await run('DELETE FROM bill_texts WHERE doc_id = ?', docId)
      expect((await groupTags()).r2).toEqual(['r2'])
    })

    it('moves when a text is redated', async () => {
      expect((await groupTags()).r1).toEqual(['r2'])
      await run("UPDATE bill_texts SET date = '2026-07-01' WHERE bill_id = 'r1'")
      expect((await groupTags()).r2).toEqual(['r1'])
    })

    it('moves to the other member when it moves further along, whatever its texts', async () => {
      expect((await groupTags()).r1).toEqual(['r2'])
      await run("UPDATE bills SET status_rank = 300 WHERE id = 'r1'")
      expect((await groupTags()).r2).toEqual(['r1'])
    })

    it('moves when a bill number changes the order of a tie', async () => {
      await run("UPDATE bill_texts SET date = '2026-03-01' WHERE bill_id = 'r1'")
      // A tie in status and newest text: HB10 comes before SB20.
      expect((await groupTags()).r2).toEqual(['r1'])
      await run("UPDATE bills SET bill_number = 'SB30' WHERE id = 'r1'")
      expect((await groupTags()).r2).toEqual(['r2'])
    })

    it('ignores whether the lead is tracked', async () => {
      await run("UPDATE bills SET match_type = NULL WHERE id = 'r2'")
      expect((await groupTags()).r1).toEqual(['r2'])
    })

    it('falls back to the most recent tracked analysis while the lead has none, and moves to the lead\'s once it has one', async () => {
      await run("UPDATE bills SET tags = '[]', tenant_summary = NULL, ai_processed_at = NULL WHERE id = 'r2'")
      expect((await groupTags()).r2).toEqual(['r1'])
      await run("UPDATE bills SET tags = '[\"r2\"]', ai_processed_at = '2026-08-01 00:00:00' WHERE id = 'r2'")
      expect((await groupTags()).r1).toEqual(['r2'])
    })

    it('recomputes a group when its lead is deleted', async () => {
      expect((await groupTags()).r1).toEqual(['r2'])
      await run("DELETE FROM bills WHERE id = 'r2'")
      expect((await groupTags()).r1).toEqual(['r1'])
    })

    it('leaves a bill in no group alone when a text is added to it', async () => {
      await insert({ id: 'solo', at: '2026-09-01 00:00:00', key: null, tags: ['mine'] })
      await text('solo', '2026-09-01')
      expect((await groupTags()).solo).toEqual(['mine'])
    })
  })

  describe('the triggers and lib/teamFields.ts agree', () => {
    // Every bill's group tags are the tags of the analysis the bill page reads for it,
    // after each of a long run of random writes: analyses, clears, match type, status,
    // and bill number changes, texts added, removed, and redated, group moves, inserts,
    // and deletes. Times, ranks, and dates come from short lists, so ties are common.

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

    type Raw = { id: string; bill_number: string; status_rank: number; tags: string; tenant_summary: string | null; ai_processed_at: string | null; match_type: string | null; group_key: string | null; newest: string | null }

    const hasAnalysis = (r: Raw) => r.ai_processed_at !== null || r.tenant_summary !== null || r.tags !== '[]'
    const split = (n: string) => { const i = n.search(/\d/); return i < 0 ? { p: n, k: 0 } : { p: n.slice(0, i), k: Number.parseInt(n.slice(i), 10) || 0 } }

    /** The rule, written out here as the ticket states it, from the raw rows. `lead` false is 0106's rule alone. */
    function byRule(rows: Raw[], id: string, lead: boolean): string[] {
      const me = rows.find(r => r.id === id)!
      if (me.group_key === null) return JSON.parse(me.tags) as string[]
      const members = rows.filter(r => r.group_key === me.group_key)
      const first = [...members].sort((a, b) => b.status_rank - a.status_rank
        || (a.newest === b.newest ? 0 : a.newest === null ? 1 : b.newest === null ? -1 : b.newest.localeCompare(a.newest))
        || (split(a.bill_number).p < split(b.bill_number).p ? -1 : split(a.bill_number).p > split(b.bill_number).p ? 1 : 0)
        || split(a.bill_number).k - split(b.bill_number).k
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
      if (lead && hasAnalysis(first)) return JSON.parse(first.tags) as string[]
      const analyzed = members.filter(hasAnalysis)
      const tracked = analyzed.filter(r => r.match_type !== null)
      const pool = tracked.length > 0 ? tracked : analyzed
      const best = [...pool].sort((a, b) => (b.ai_processed_at ?? '').localeCompare(a.ai_processed_at ?? '') || b.id.localeCompare(a.id))[0]
      return best ? JSON.parse(best.tags) as string[] : []
    }

    /** How many times a bill's group showed a different analysis than 0106's rule would: the lead at work. */
    let differed = 0

    async function expectAgreement(step: string) {
      const stored = await groupTags()
      const read = await loadTeamValuesOf(getDb(env.DB), Object.keys(stored))
      const fromTs = Object.fromEntries(Object.keys(stored).map(id => [id, read.get(id)?.analysis?.tags ?? []]))
      expect(stored, `${step}: group_tags against lib/teamFields.ts`).toEqual(fromTs)
      const { results: raw } = await env.DB.prepare(`SELECT id, bill_number, status_rank, tags, tenant_summary, ai_processed_at, match_type, group_key,
        (SELECT MAX(NULLIF(date, '')) FROM bill_texts t WHERE t.bill_id = bills.id) AS newest FROM bills`).all<Raw>()
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
        const RANKS = [100, 100, 200, 300] as const
        const DATES = ['2026-01-01', '2026-02-01', '2026-02-01', '2026-03-01', ''] as const
        const NUMBERS = ['HB1', 'HB2', 'HB10', 'SB1', 'SB9', 'HR'] as const
        let n = 0
        const analysis = () => {
          n += 1
          const at = pick(TIMES)
          const tags = rnd() < 0.25 ? [] : [`t${n}`]
          // An analysis is a time, a summary, or tags. Keep at least one.
          const summary = at === null && tags.length === 0 ? `s${n}` : rnd() < 0.8 ? `s${n}` : null
          return { tags, summary, at }
        }
        const add = async (id: string, a: { tags: string[]; summary: string | null; at: string | null }) => {
          await run(`INSERT INTO bills (id, bill_number, title, state, status, status_rank, session, tags, tenant_summary, ai_processed_at, match_type, group_key)
            VALUES (?, ?, 't', 'TX', 's', ?, 's', ?, ?, ?, ?, ?)`, id, pick(NUMBERS), pick(RANKS), JSON.stringify(a.tags), a.summary, a.at, pick(MATCH), pick(KEYS))
        }
        const ids: string[] = []
        for (let i = 0; i < 12; i++) {
          const id = `b${String(i).padStart(2, '0')}`
          await add(id, rnd() < 0.7 ? analysis() : { tags: [], summary: null, at: null })
          if (rnd() < 0.5) await text(id, pick(DATES))
          ids.push(id)
        }
        await expectAgreement('seeded')
        for (let step = 0; step < 50; step++) {
          const id = pick(ids)
          const r = rnd()
          if (r < 0.15) {
            const a = analysis()
            await run('UPDATE bills SET tags = ?, tenant_summary = ?, ai_processed_at = ? WHERE id = ?', JSON.stringify(a.tags), a.summary, a.at, id)
          } else if (r < 0.2) {
            await run("UPDATE bills SET tags = '[]', tenant_summary = NULL, ai_processed_at = NULL WHERE id = ?", id)
          } else if (r < 0.3) {
            await run('UPDATE bills SET match_type = ? WHERE id = ?', pick(MATCH), id)
          } else if (r < 0.4) {
            await run('UPDATE bills SET status_rank = ? WHERE id = ?', pick(RANKS), id)
          } else if (r < 0.45) {
            await run('UPDATE bills SET bill_number = ? WHERE id = ?', pick(NUMBERS), id)
          } else if (r < 0.58) {
            await text(id, pick(DATES))
          } else if (r < 0.64) {
            await run('DELETE FROM bill_texts WHERE doc_id = (SELECT doc_id FROM bill_texts WHERE bill_id = ? LIMIT 1)', id)
          } else if (r < 0.7) {
            await run('UPDATE bill_texts SET date = ? WHERE doc_id = (SELECT doc_id FROM bill_texts WHERE bill_id = ? LIMIT 1)', pick(DATES), id)
          } else if (r < 0.85) {
            await run('UPDATE bills SET group_key = ? WHERE id = ?', pick(KEYS), id)
          } else if (r < 0.93) {
            const fresh = `n${step}`
            await add(fresh, analysis())
            ids.push(fresh)
          } else if (ids.length > 4) {
            await run('DELETE FROM bills WHERE id = ?', id)
            ids.splice(ids.indexOf(id), 1)
          }
          await expectAgreement(`seed ${seed}, step ${step}`)
        }
        // The run reached groups where the lead and 0106's rule part ways.
        expect(differed).toBeGreaterThan(0)
      })
    }
  })

  it('agrees with the lead lib/teamFields.ts reads, over groups that tie in different ways', async () => {
    await resetDb()
    await applyMigrations()
    for (const f of [
      // Natural number order: HB9 before HB10.
      { id: 'n1', number: 'HB10', key: 'n1' }, { id: 'n2', number: 'HB9', key: 'n1' },
      // Letters first: AB500 before SB1.
      { id: 'l1', number: 'SB1', key: 'l1' }, { id: 'l2', number: 'AB500', key: 'l1' },
      // A full tie: the smaller id.
      { id: 'i1', number: 'HB1', key: 'i1' }, { id: 'i2', number: 'HB1', key: 'i1' },
      // A bill with no number digits (its number is 0) and a text dated empty, which counts as none.
      { id: 'd1', number: 'HR', key: 'd1', texts: [''] }, { id: 'd2', number: 'HR5', key: 'd1' },
      // Three members, the newest text on the untracked one, the latest analysis on another.
      { id: 't1', number: 'S1', key: 't1', texts: ['2026-01-01'], at: '2026-09-09 00:00:00' },
      { id: 't2', number: 'S2', key: 't1', texts: ['2026-04-01'], match: null },
      { id: 't3', number: 'S3', key: 't1', texts: ['2026-02-01', '2026-03-01'] },
      // The lead unanalyzed, a pulled companion analyzed most recently.
      { id: 'u1', number: 'A1', key: 'u1', rank: 400, at: null },
      { id: 'u2', number: 'A2', key: 'u1', at: '2026-09-01 00:00:00' },
      { id: 'u3', number: 'A3', key: 'u1', at: '2026-09-07 00:00:00', match: null },
    ] satisfies Fixture[]) await insert(f)
    const stored = await groupTags()
    const read = await loadTeamValuesOf(getDb(env.DB), Object.keys(stored))
    for (const [id, tags] of Object.entries(stored)) expect([id, tags]).toEqual([id, read.get(id)?.analysis?.tags ?? []])
    // And the leads are the ones the rule names.
    expect([stored.n1, stored.l1, stored.i1, stored.d1, stored.t1, stored.u1]).toEqual([['n2'], ['l2'], ['i1'], ['d1'], ['t2'], ['u2']])
  })
})
