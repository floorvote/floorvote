import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { legiscanMigrations, parseMigrations, setupDb } from './migrations'

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
  it('applies every file in migrations/', async () => {
    await setupDb(legiscanMigrations)
    const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()
    expect(applied.results.map(r => r.name)).toEqual(parseMigrations(legiscanMigrations).map(m => m.name))
    expect(applied.results.length).toBe(Object.keys(legiscanMigrations).length)
  })

  it('applies the 0015 calendar date index, whose comment contains a semicolon', async () => {
    await setupDb(legiscanMigrations)
    const idx = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bill_calendar_date'",
    ).first()
    expect(idx).not.toBeNull()
  })
})
