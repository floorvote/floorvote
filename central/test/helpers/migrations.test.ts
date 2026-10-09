import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { legiscanMigrations, openStatesMigrations, parseMigrations, setupDb, splitStatements } from './migrations'

describe('splitStatements', () => {
  it('ignores semicolons in comments and string literals', () => {
    const sql = [
      '-- a full scan; slow',
      'CREATE TABLE t (a TEXT); -- trailing; comment',
      "/* block; comment */ INSERT INTO t VALUES ('x;y', 'it''s');",
      'CREATE INDEX i ON t(a)',
    ].join('\n')
    expect(splitStatements(sql)).toEqual([
      'CREATE TABLE t (a TEXT);',
      "INSERT INTO t VALUES ('x;y', 'it''s');",
      'CREATE INDEX i ON t(a);',
    ])
  })
})

describe('parseMigrations', () => {
  it('orders any folder by filename and names by basename', () => {
    const parsed = parseMigrations({
      '../fork/0002_b.sql': 'SELECT 2;',
      '../fork/0001_a.sql': 'SELECT 1;',
    })
    expect(parsed).toEqual([
      { name: '0001_a', queries: ['SELECT 1;'] },
      { name: '0002_b', queries: ['SELECT 2;'] },
    ])
  })
})

describe('setupDb', () => {
  it.each([
    ['migrations-legiscan', legiscanMigrations],
    ['migrations', openStatesMigrations],
  ])('applies every file in %s', async (_dir, files) => {
    await setupDb(files)
    const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()
    expect(applied.results.map(r => r.name)).toEqual(parseMigrations(files).map(m => m.name))
    expect(applied.results.length).toBe(Object.keys(files).length)
  })

  it('applies the 0015 calendar date index, whose comment contains a semicolon', async () => {
    await setupDb(legiscanMigrations)
    const idx = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bill_calendar_date'",
    ).first()
    expect(idx).not.toBeNull()
  })
})
