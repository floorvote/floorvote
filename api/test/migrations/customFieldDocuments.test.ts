import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, parseMigration, seedBill } from '../helpers'
import migrationSql74 from '../../migrations/0074_custom_field_documents.sql?raw'

/** Replay the rebuild by hand, using the same parser production uses.
 *  applyMigrations() already ran it against an empty DB during setup, so
 *  seeding first and replaying is the only way to see what it does to rows
 *  that already exist. */
async function runRebuild(): Promise<void> {
  const { queries } = parseMigration(migrationSql74, '0074_custom_field_documents')
  for (const q of queries) await env.DB.prepare(q).run()
}

async function seed(): Promise<void> {
  await env.DB.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@b.c', 'A', 'owner')`).run()
  await seedBill({ id: 'b1' })
  await env.DB.prepare(
    `INSERT INTO custom_field_definitions (id, name, slug, type, options, display_order, pinned, multiple, created_at, updated_at)
     VALUES ('f1', 'Region', 'region', 'dropdown', '["North","South"]', 3, 1, 1, '2026-01-01 00:00:00', '2026-01-02 00:00:00'),
            ('f2', 'Notes', 'notes', 'text', NULL, 4, 0, 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
  ).run()
  await env.DB.prepare(
    `INSERT INTO bill_custom_field_values (bill_id, field_id, value, set_by, updated_at)
     VALUES ('b1', 'f1', '["North"]', 'u1', '2026-02-01 00:00:00'),
            ('b1', 'f2', 'Some notes', 'u1', '2026-02-02 00:00:00')`,
  ).run()
}

describe('0074_custom_field_documents', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('keeps every stored value when foreign keys are enforced, as on D1', async () => {
    await env.DB.prepare(`PRAGMA foreign_keys = ON`).run()
    await seed()

    await runRebuild()

    const { results } = await env.DB.prepare(
      `SELECT bill_id, field_id, value, set_by, updated_at FROM bill_custom_field_values ORDER BY field_id`,
    ).all()
    expect(results).toEqual([
      { bill_id: 'b1', field_id: 'f1', value: '["North"]', set_by: 'u1', updated_at: '2026-02-01 00:00:00' },
      { bill_id: 'b1', field_id: 'f2', value: 'Some notes', set_by: 'u1', updated_at: '2026-02-02 00:00:00' },
    ])
  })

  it('keeps every field definition column', async () => {
    await seed()
    await runRebuild()

    const row = await env.DB.prepare(`SELECT * FROM custom_field_definitions WHERE id = 'f1'`).first()
    expect(row).toEqual({
      id: 'f1', name: 'Region', slug: 'region', type: 'dropdown', options: '["North","South"]',
      display_order: 3, pinned: 1, multiple: 1, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-02 00:00:00',
    })
  })

  it('accepts the document type and still refuses unknown types', async () => {
    await env.DB.prepare(
      `INSERT INTO custom_field_definitions (id, name, type) VALUES ('d1', 'Testimony', 'document')`,
    ).run()
    await expect(env.DB.prepare(
      `INSERT INTO custom_field_definitions (id, name, type) VALUES ('x1', 'Bad', 'bogus')`,
    ).run()).rejects.toThrow()
  })

  it('keeps the unique slug index and the cascades', async () => {
    await env.DB.prepare(`PRAGMA foreign_keys = ON`).run()
    await seed()
    await runRebuild()

    await expect(env.DB.prepare(
      `INSERT INTO custom_field_definitions (id, name, slug, type) VALUES ('f3', 'Region 2', 'region', 'text')`,
    ).run()).rejects.toThrow()

    await env.DB.prepare(`DELETE FROM custom_field_definitions WHERE id = 'f1'`).run()
    const { results } = await env.DB.prepare(`SELECT field_id FROM bill_custom_field_values`).all()
    expect(results).toEqual([{ field_id: 'f2' }])
  })

  it('leaves no scratch table behind', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('bill_custom_field_values_keep', 'custom_field_definitions_new')`,
    ).all()
    expect(results).toEqual([])
  })
})
