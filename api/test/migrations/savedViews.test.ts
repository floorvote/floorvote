import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

describe('0064_saved_views', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('creates saved_views with the expected columns', async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(saved_views)`).all()
    const names = (results as { name: string }[]).map(r => r.name).sort()
    expect(names).toEqual(
      ['created_at', 'created_by', 'display_order', 'id', 'name', 'query', 'updated_at'].sort(),
    )
  })

  it('survives a delete of the creating user, with created_by cleared', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@example.com', 'A', 'admin')`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO saved_views (id, name, query, created_by, display_order)
       VALUES ('v1', 'Clerk bills', 'subject=UT%3AElections', 'u1', 0)`,
    ).run()
    await env.DB.prepare(`DELETE FROM users WHERE id = 'u1'`).run()
    const { results } = await env.DB.prepare(`SELECT id, created_by FROM saved_views`).all()
    expect(results).toEqual([{ id: 'v1', created_by: null }])
  })
})
