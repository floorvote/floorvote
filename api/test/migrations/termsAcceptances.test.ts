import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb } from '../helpers'

describe('migration 0069_terms_acceptances', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('creates the table with the expected columns', async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(terms_acceptances)`).all()
    const cols = results as Array<{ name: string; notnull: number; pk: number }>
    expect(cols.map(c => c.name).sort()).toEqual(['accepted_at', 'id', 'terms_updated', 'user_id'])
    expect(cols.find(c => c.name === 'id')!.pk).toBe(1)
    expect(cols.find(c => c.name === 'user_id')!.notnull).toBe(1)
    expect(cols.find(c => c.name === 'terms_updated')!.notnull).toBe(1)
  })

  it('indexes (user_id, accepted_at) so the newest-row lookup in requireAuth is not a scan', async () => {
    const { results } = await env.DB.prepare(`PRAGMA index_list(terms_acceptances)`).all()
    const names = (results as Array<{ name: string }>).map(r => r.name)
    expect(names).toContain('idx_terms_acceptances_user')
  })

  it('accepts more than one row per user — re-acceptance is an insert, not an update', async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@b.c', 'A', 'member')`).run()
    await env.DB.prepare(`INSERT INTO terms_acceptances (id, user_id, terms_updated, accepted_at)
      VALUES ('t1', 'u1', '2026-09-11', '2026-09-11 00:00:00')`).run()
    await env.DB.prepare(`INSERT INTO terms_acceptances (id, user_id, terms_updated, accepted_at)
      VALUES ('t2', 'u1', '2027-01-04', '2027-01-04 00:00:00')`).run()
    const { results } = await env.DB.prepare(
      `SELECT terms_updated FROM terms_acceptances WHERE user_id = 'u1' ORDER BY accepted_at DESC`).all()
    expect((results as Array<{ terms_updated: string }>).map(r => r.terms_updated))
      .toEqual(['2027-01-04', '2026-09-11'])
  })

  it('cascades on user delete', async () => {
    await env.DB.prepare(`PRAGMA foreign_keys = ON`).run()
    await env.DB.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u2', 'c@d.e', 'C', 'member')`).run()
    await env.DB.prepare(`INSERT INTO terms_acceptances (id, user_id, terms_updated, accepted_at)
      VALUES ('t3', 'u2', '2026-09-11', '2026-09-11 00:00:00')`).run()
    await env.DB.prepare(`DELETE FROM users WHERE id = 'u2'`).run()
    const { results } = await env.DB.prepare(
      `SELECT id FROM terms_acceptances WHERE user_id = 'u2'`).all()
    expect(results).toEqual([])
  })
})
