import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import { splitStatements } from '../../../shared/sqlStatements'

const files = import.meta.glob<string>('../../migrations/0109_*.sql', { query: '?raw', import: 'default', eager: true })

// Migration 0109 adds saved_view_subscriptions (#449): one row per member and
// saved view, with no existing table touched.
describe('migration 0109_saved_view_subscriptions', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0109' })
  })

  const tables = async () => (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()).results.map(r => r.name)

  it('creates the table over an existing database, leaving its rows alone', async () => {
    await env.DB.prepare(`INSERT INTO users (id, email, name) VALUES ('u1', 'u1@example.com', 'U1')`).run()
    await env.DB.prepare(`INSERT INTO saved_views (id, name, query, slug) VALUES ('v1', 'Roads', 'state=RI', 'roads')`).run()
    expect(await tables()).not.toContain('saved_view_subscriptions')

    await applyMigrations()

    expect(await tables()).toContain('saved_view_subscriptions')
    expect((await env.DB.prepare('SELECT id FROM users').all()).results).toEqual([{ id: 'u1' }])
    expect((await env.DB.prepare('SELECT id, name, query FROM saved_views').all()).results).toEqual([{ id: 'v1', name: 'Roads', query: 'state=RI' }])
  })

  it('runs again over a database that has it, without error and without losing a subscription', async () => {
    await applyMigrations()
    const sql = Object.values(files)
    expect(sql).toHaveLength(1)
    await env.DB.prepare(`INSERT INTO users (id, email, name) VALUES ('u1', 'u1@example.com', 'U1')`).run()
    await env.DB.prepare(`INSERT INTO saved_views (id, name, query, slug) VALUES ('v1', 'Roads', 'state=RI', 'roads')`).run()
    await env.DB.prepare(`INSERT INTO saved_view_subscriptions (user_id, view_id) VALUES ('u1', 'v1')`).run()

    for (const q of splitStatements(sql[0])) await env.DB.prepare(q).run()

    expect((await env.DB.prepare('SELECT user_id, view_id FROM saved_view_subscriptions').all()).results).toEqual([{ user_id: 'u1', view_id: 'v1' }])
  })

  it('holds one row per member and view, and removes it with the view or the member', async () => {
    await applyMigrations()
    expect(await tables()).toContain('saved_view_subscriptions')
    await env.DB.prepare(`INSERT INTO users (id, email, name) VALUES ('u1', 'u1@example.com', 'U1'), ('u2', 'u2@example.com', 'U2')`).run()
    await env.DB.prepare(`INSERT INTO saved_views (id, name, query, slug) VALUES ('v1', 'Roads', 'state=RI', 'roads'), ('v2', 'Votes', 'state=UT', 'votes')`).run()
    const add = (u: string, v: string) => env.DB.prepare('INSERT INTO saved_view_subscriptions (user_id, view_id) VALUES (?, ?)').bind(u, v).run()
    await add('u1', 'v1'); await add('u2', 'v1'); await add('u1', 'v2')
    await expect(add('u1', 'v1')).rejects.toThrow()

    await env.DB.prepare(`DELETE FROM saved_views WHERE id = 'v2'`).run()
    await env.DB.prepare(`DELETE FROM users WHERE id = 'u2'`).run()

    expect((await env.DB.prepare('SELECT user_id, view_id FROM saved_view_subscriptions').all()).results).toEqual([{ user_id: 'u1', view_id: 'v1' }])
  })
})
