/// <reference types="vite/client" />
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb, parseMigration } from '../helpers'

// The test database must be the schema production has: every file in
// api/migrations/, applied in order.
const files = import.meta.glob<string>('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true })
const onDisk = Object.keys(files).map(p => p.split('/').pop()!.replace(/\.sql$/, '')).sort()

describe('test database migrations', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('finds the migrations directory', () => {
    expect(onDisk.length).toBeGreaterThan(70)
  })

  it('applies every migration file in api/migrations/, in order', async () => {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()
    expect(results.map(r => r.name)).toEqual(onDisk)
  })

  // Recording a migration as applied doesn't prove its statements ran, so also
  // check the splitter found SQL in every file that has any once comments are
  // stripped. Comment-only files (0024, say) are detected by stripping, not listed.
  it('parses at least one statement from every file that has SQL', () => {
    const hasSql = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').some(l => l.trim() !== '' && !l.trimStart().startsWith('--'))
    const empty = Object.entries(files)
      .filter(([, sql]) => hasSql(sql) && parseMigration(sql, '').queries.length === 0)
      .map(([path]) => path)
    expect(empty).toEqual([])
  })

  it('has the facet indexes from 0060', async () => {
    const { results } = await env.DB.prepare(`PRAGMA index_list(bills)`).all<{ name: string }>()
    const names = results.map(r => r.name)
    expect(names).toContain('idx_bills_priority')
    expect(names).toContain('idx_bills_year_start')
  })
})
