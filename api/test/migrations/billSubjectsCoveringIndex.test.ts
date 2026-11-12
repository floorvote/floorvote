import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// 0125 gives a bill's subject rows a covering index by the bill, so the join from the bills to their subjects
// (state and name, which the primary key's index lacks) reads the index alone, not a table row for each of them.
describe('migration 0125: the covering index of a bill\'s subjects', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0125_bill_subjects_covering_index' })
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
        INSERT INTO bills (id, bill_number, title, state, status, session, year_start)
        SELECT 'bill' || printf('%04d', i), 'HB' || i, 't', 'NJ', 'Introduced', 's', 2026 FROM n`),
      env.DB.prepare(`INSERT INTO bill_subjects (bill_id, subject_name, state) SELECT id, 'Subject A', state FROM bills`),
      env.DB.prepare(`INSERT INTO bill_subjects (bill_id, subject_name, state) SELECT id, 'Subject B', state FROM bills WHERE substr(id, 5) % 2 = 0`),
    ])
  })

  const columnsOf = async (index: string): Promise<string[]> => {
    const { results } = await env.DB.prepare(`SELECT name FROM pragma_index_info('${index}') ORDER BY seqno`).all<{ name: string }>()
    return results.map(r => r.name)
  }

  describe('once applied', () => {
    beforeEach(async () => { await applyMigrations() })

    it('creates idx_bill_subjects_bill over the bill, the state, and the subject name', async () => {
      expect(await columnsOf('idx_bill_subjects_bill')).toEqual(['bill_id', 'state', 'subject_name'])
    })

    it('holds every subject row already there', async () => {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM bill_subjects INDEXED BY idx_bill_subjects_bill').first<{ n: number }>()
      expect(row?.n).toBe(900)
    })

    it('lets the join from a bill to its subjects read the index alone', async () => {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT bs.state, bs.subject_name, COUNT(*) FROM bills m CROSS JOIN bill_subjects bs ON bs.bill_id = m.id WHERE m.id = ? GROUP BY bs.state, bs.subject_name`)
        .bind('bill0001').all<{ detail: string }>()
      expect(results.map(r => r.detail).join('\n')).toMatch(/SEARCH bs USING COVERING INDEX idx_bill_subjects_bill \(bill_id=\?\)/)
    })

    it('keeps the indexes the other readers use', async () => {
      const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bill_subjects'").all<{ name: string }>()
      expect(results.map(r => r.name)).toEqual(expect.arrayContaining(['idx_bill_subjects_name', 'sqlite_autoindex_bill_subjects_1']))
    })

    it('analyzes the table so the planner has the index\'s statistics', async () => {
      const row = await env.DB.prepare("SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_bill_subjects_bill'").first<{ stat: string }>()
      expect(row).not.toBeNull()
    })

    it('leaves a clean schema when the whole migration set is applied to a fresh database', async () => {
      await resetDb()
      await applyMigrations()
      expect(await columnsOf('idx_bill_subjects_bill')).toHaveLength(3)
      const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_bill_subjects_bill'").all<{ n: number }>()
      expect(results[0].n).toBe(1)
    })
  })
})
