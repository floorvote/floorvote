import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'

describe('0065_saved_view_slugs', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('adds nullable slug and previous_slug columns', async () => {
    const { results } = await env.DB.prepare(`PRAGMA table_info(saved_views)`).all()
    const cols = results as { name: string; notnull: number }[]
    const slug = cols.find(c => c.name === 'slug')
    const previousSlug = cols.find(c => c.name === 'previous_slug')
    expect(slug?.notnull).toBe(0)
    expect(previousSlug?.notnull).toBe(0)
  })

  it('enforces uniqueness on slug', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_views (id, name, query, slug, display_order) VALUES ('v1', 'Clerk bills', 'status=1', 'clerk-bills', 0)`,
    ).run()
    await expect(
      env.DB.prepare(
        `INSERT INTO saved_views (id, name, query, slug, display_order) VALUES ('v2', 'Other', 'status=2', 'clerk-bills', 1)`,
      ).run(),
    ).rejects.toThrow()
  })

  it('allows multiple rows with a null slug — the unique index does not block pre-backfill rows', async () => {
    await env.DB.prepare(
      `INSERT INTO saved_views (id, name, query, display_order) VALUES ('v1', 'Clerk bills', 'status=1', 0)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO saved_views (id, name, query, display_order) VALUES ('v2', 'Other', 'status=2', 1)`,
    ).run()
    const { results } = await env.DB.prepare(`SELECT id FROM saved_views WHERE slug IS NULL`).all()
    expect(results?.length).toBe(2)
  })
})
