/// <reference types="vite/client" />
import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb } from '../helpers'

// The test database must be the schema production has: every file in
// api/migrations/, applied in order. This guards against a migration being
// left out of the test database, which is how 0060 went missing for months.
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

  it('has the facet indexes from 0060', async () => {
    const { results } = await env.DB.prepare(`PRAGMA index_list(bills)`).all<{ name: string }>()
    const names = results.map(r => r.name)
    expect(names).toContain('idx_bills_priority')
    expect(names).toContain('idx_bills_year_start')
  })
})
