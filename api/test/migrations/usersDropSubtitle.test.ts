import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedSession } from '../helpers'

// Migration 0120 finishes the rename of users.subtitle to users.title (#539,
// #564). 0105 added `title` and kept `subtitle`, so the previous build kept
// working through the deploy and a rollback. Once that build is gone, 0120
// copies any `subtitle` that has no `title` across, then drops `subtitle`.
describe('migration 0120_drop_users_subtitle', () => {
  beforeEach(async () => {
    await resetDb()
    // The database as a build from before the drop leaves it: both columns exist.
    await applyMigrations({ before: '0120' })
  })

  const insert = (id: string, { title, subtitle }: { title: string | null; subtitle: string | null }) =>
    env.DB.prepare('INSERT INTO users (id, email, name, title, subtitle) VALUES (?, ?, ?, ?, ?)')
      .bind(id, `${id}@example.com`, id, title, subtitle).run()
  const columns = async () => (await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>()).results.map(c => c.name)
  const titles = async () => (await env.DB.prepare('SELECT id, title FROM users ORDER BY id').all()).results

  it('drops users.subtitle and keeps users.title', async () => {
    expect(await columns()).toEqual(expect.arrayContaining(['title', 'subtitle']))
    await applyMigrations()
    const after = await columns()
    expect(after).not.toContain('subtitle')
    expect(after).toContain('title')
  })

  it('loses no value: a member with only a subtitle, only a title, and both each keep one title', async () => {
    await insert('only-subtitle', { title: null, subtitle: 'Written by the old build' })
    await insert('only-title', { title: 'Senior Policy Analyst, Elections', subtitle: null })
    await insert('both-same', { title: 'Registrar', subtitle: 'Registrar' })

    await applyMigrations()

    expect(await titles()).toEqual([
      { id: 'both-same', title: 'Registrar' },
      { id: 'only-subtitle', title: 'Written by the old build' },
      { id: 'only-title', title: 'Senior Policy Analyst, Elections' },
    ])
  })

  it('never overwrites a title with a different subtitle: the title wins', async () => {
    await insert('differ', { title: 'Current', subtitle: 'Stale' })
    await applyMigrations()
    expect(await titles()).toEqual([{ id: 'differ', title: 'Current' }])
  })

  it('leaves a member with neither a title nor a subtitle with a null title', async () => {
    await insert('neither', { title: null, subtitle: null })
    await applyMigrations()
    expect(await titles()).toEqual([{ id: 'neither', title: null }])
  })

  it('copies an empty-string subtitle into a null title verbatim, and leaves an empty title alone', async () => {
    await insert('blank-subtitle', { title: null, subtitle: '' })
    await insert('blank-title', { title: '', subtitle: 'Ignored' })
    await applyMigrations()
    expect(await titles()).toEqual([
      { id: 'blank-subtitle', title: '' },
      { id: 'blank-title', title: '' },
    ])
  })

  it('carries non-ASCII and long titles across unchanged', async () => {
    const long = 'x'.repeat(200)
    await insert('unicode', { title: null, subtitle: 'Clerk · Cranston — Ward 5' })
    await insert('long', { title: null, subtitle: long })
    await applyMigrations()
    expect(await titles()).toEqual([
      { id: 'long', title: long },
      { id: 'unicode', title: 'Clerk · Cranston — Ward 5' },
    ])
  })

  it('runs on a database with no users', async () => {
    await applyMigrations()
    expect(await columns()).not.toContain('subtitle')
    expect(await titles()).toEqual([])
  })

  it('keeps every other column of a member, and the rows that point at them', async () => {
    await env.DB.prepare('INSERT INTO users (id, email, name, role, subtitle, can_vote) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('u1', 'u1@example.com', 'Una', 'admin', 'Town Clerk', 0).run()
    await seedSession('u1')
    const before = await env.DB.prepare('SELECT id, email, name, role, can_vote, created_at, last_active FROM users WHERE id = ?').bind('u1').first()

    await applyMigrations()

    expect(await env.DB.prepare('SELECT id, email, name, role, can_vote, created_at, last_active FROM users WHERE id = ?').bind('u1').first()).toEqual(before)
    expect(await env.DB.prepare('SELECT title FROM users WHERE id = ?').bind('u1').first()).toEqual({ title: 'Town Clerk' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind('u1').first()).toEqual({ n: 1 })
  })

  it('is recorded as applied once, so a second run changes nothing', async () => {
    await insert('u', { title: null, subtitle: 'Once' })
    await applyMigrations()
    await applyMigrations()
    expect(await titles()).toEqual([{ id: 'u', title: 'Once' }])
    const applied = (await env.DB.prepare('SELECT name FROM d1_migrations WHERE name = ?').bind('0120_drop_users_subtitle').all()).results
    expect(applied).toHaveLength(1)
  })

  it('rejects an insert that names subtitle, which the previous build would send', async () => {
    await applyMigrations()
    await expect(
      env.DB.prepare('INSERT INTO users (id, email, name, subtitle) VALUES (?, ?, ?, ?)').bind('late', 'late@example.com', 'late', 'x').run(),
    ).rejects.toThrow(/subtitle/)
  })
})
