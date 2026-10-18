import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// Migration 0108 adds a bill's claim sources and the document they are pinned
// to (#568). Null means the bill has none, which is every bill until its next
// analysis, so existing summaries render exactly as before.
describe('migration 0108_claim_sources', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0108' })
  })

  const columns = async () =>
    (await env.DB.prepare('PRAGMA table_info(bills)').all<{ name: string; notnull: number; dflt_value: string | null; type: string }>()).results

  it('adds three nullable text columns with no default', async () => {
    await applyMigrations()
    const cols = await columns()
    for (const name of ['claim_sources', 'claim_sources_doc_id', 'claim_sources_text_hash']) {
      expect(cols.find(c => c.name === name)).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    }
  })

  it('leaves every existing bill with no claim sources', async () => {
    await env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, tenant_summary) VALUES ('b1', 'HB 1', 'T', 'ZZ', 'A summary.')`).run()
    await applyMigrations()
    const row = await env.DB.prepare(`SELECT * FROM bills WHERE id = 'b1'`).first()
    expect(row).toMatchObject({ claim_sources: null, claim_sources_doc_id: null, claim_sources_text_hash: null, tenant_summary: 'A summary.' })
  })

  it('stores items as JSON objects a later field can be added to and counted by, with no schema change', async () => {
    await applyMigrations()
    const items = [
      { claim: 'a', quote: 'x', status: 'exact' },
      { claim: 'b', quote: 'y', status: 'ungrounded' },
      { claim: 'c', quote: 'z', status: 'exact' },
    ]
    const cols = (await columns()).map(c => c.name)
    expect(cols).toContain('claim_sources')
    await env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, claim_sources, claim_sources_doc_id) VALUES ('b2', 'HB 2', 'T', 'ZZ', ?, '5001')`)
      .bind(JSON.stringify(items)).run()
    const { results } = await env.DB.prepare(
      `SELECT json_extract(j.value, '$.status') AS item_status, COUNT(*) AS n FROM bills, json_each(bills.claim_sources) j GROUP BY item_status ORDER BY item_status`,
    ).all()
    expect(results).toEqual([{ item_status: 'exact', n: 2 }, { item_status: 'ungrounded', n: 1 }])
  })
})
