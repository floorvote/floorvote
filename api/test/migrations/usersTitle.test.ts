import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

// Migration 0105 adds users.title beside users.subtitle (#539), copies each
// member's line under their name across, and KEEPS subtitle. The rename is two
// steps so a rollback, and the window between the migration and the new build
// going live, both leave the previous build working: it still reads and writes
// subtitle. A later migration (a follow-up issue) drops subtitle.
describe('migration 0105_users_title', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations({ before: '0105' })
  })

  const insert = (id: string, title: string | null) =>
    env.DB.prepare('INSERT INTO users (id, email, name, subtitle) VALUES (?, ?, ?, ?)')
      .bind(id, `${id}@example.com`, id, title).run()
  const columns = async () => (await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>()).results.map(c => c.name)

  it('copies every existing value into the new title column, and the null of a member who has none', async () => {
    await insert('with-title', 'Senior Policy Analyst, Elections')
    await insert('no-title', null)
    await insert('unicode', 'Clerk · Cranston')
    await insert('blank', '')

    await applyMigrations()

    const { results } = await env.DB.prepare('SELECT id, title FROM users ORDER BY id').all()
    expect(results).toEqual([
      { id: 'blank', title: '' },
      { id: 'no-title', title: null },
      { id: 'unicode', title: 'Clerk · Cranston' },
      { id: 'with-title', title: 'Senior Policy Analyst, Elections' },
    ])
  })

  it('keeps subtitle, with its values untouched, so the previous build still works', async () => {
    await insert('with-title', 'Senior Policy Analyst, Elections')
    await insert('no-title', null)

    await applyMigrations()

    expect(await columns()).toEqual(expect.arrayContaining(['title', 'subtitle']))
    const { results } = await env.DB.prepare('SELECT id, subtitle FROM users ORDER BY id').all()
    expect(results).toEqual([
      { id: 'no-title', subtitle: null },
      { id: 'with-title', subtitle: 'Senior Policy Analyst, Elections' },
    ])
  })

  it('still accepts the previous build\'s inserts and updates of subtitle after the migration', async () => {
    await insert('u', 'Before')
    await applyMigrations()
    // What the previous build does after the migration, in its own SQL.
    await env.DB.prepare('INSERT INTO users (id, email, name, subtitle) VALUES (?, ?, ?, ?)').bind('late', 'late@example.com', 'late', 'Written by the old build').run()
    await env.DB.prepare('UPDATE users SET subtitle = ? WHERE id = ?').bind('Edited by the old build', 'u').run()
    const { results } = await env.DB.prepare('SELECT id, subtitle FROM users ORDER BY id').all()
    expect(results).toEqual([{ id: 'late', subtitle: 'Written by the old build' }, { id: 'u', subtitle: 'Edited by the old build' }])
  })

  it('leaves both columns null for a member created with no title', async () => {
    await applyMigrations()
    await env.DB.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)').bind('n', 'n@example.com', 'n').run()
    expect(await env.DB.prepare('SELECT title, subtitle FROM users WHERE id = ?').bind('n').first()).toEqual({ title: null, subtitle: null })
  })
})
