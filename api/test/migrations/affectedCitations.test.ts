import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

describe('0066_affected_citations', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('adds affected_citations defaulting to an empty JSON array', async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(bills)`).all()
    const col = (results as { name: string; notnull: number; dflt_value: string }[])
      .find(c => c.name === 'affected_citations')
    expect(col?.notnull).toBe(1)
    expect(col?.dflt_value).toBe("'[]'")
  })

  it('backfills existing rows with an empty array rather than null', async () => {
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state) VALUES ('b1', 'HB 1', 'Election Act', 'UT')`,
    ).run()
    const row = await env.DB.prepare(`SELECT affected_citations FROM bills WHERE id='b1'`).first()
    expect(row?.affected_citations).toBe('[]')
  })

  it('round-trips a citation list', async () => {
    await env.DB.prepare(
      `INSERT INTO bills (id, bill_number, title, state, affected_citations) VALUES ('b2', 'HB 2', 'T', 'UT', ?)`,
    ).bind(JSON.stringify(['17-70-401', '10-3-301'])).run()
    const row = await env.DB.prepare(`SELECT affected_citations FROM bills WHERE id='b2'`).first()
    expect(JSON.parse(String(row?.affected_citations))).toEqual(['17-70-401', '10-3-301'])
  })
})
