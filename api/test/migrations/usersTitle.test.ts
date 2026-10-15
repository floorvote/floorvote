import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// Migration 0105 renames users.subtitle to users.title (#539). A member's line
// under their name has to come through the rename, row for row.
describe('migration 0105_users_title', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0105' })
  })

  const insert = (id: string, title: string | null) =>
    env.DB.prepare('INSERT INTO users (id, email, name, subtitle) VALUES (?, ?, ?, ?)')
      .bind(id, `${id}@example.com`, id, title).run()

  it('keeps every existing value under the new name, and the null of a member who has none', async () => {
    await insert('with-title', 'Senior Policy Analyst, Elections')
    await insert('no-title', null)
    await insert('unicode', 'Clerk · Cranston')

    await applyMigrations()

    const { results } = await env.DB.prepare('SELECT id, title FROM users ORDER BY id').all()
    expect(results).toEqual([
      { id: 'no-title', title: null },
      { id: 'unicode', title: 'Clerk · Cranston' },
      { id: 'with-title', title: 'Senior Policy Analyst, Elections' },
    ])
  })

  it('leaves no subtitle column behind', async () => {
    await applyMigrations()
    const columns = (await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>()).results.map(c => c.name)
    expect(columns).toContain('title')
    expect(columns).not.toContain('subtitle')
  })
})
