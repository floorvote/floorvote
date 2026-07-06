import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { ensureInstancePreset } from '../../src/lib/instancePreset'
import { associationConfig } from '../../src/db/schema'

const testEnv = {
  ...env,
  TENANT_ID: 'nj-test',
  INSTANCE_PRESET: 'election_officials',
}

async function getName(db: ReturnType<typeof getDb>): Promise<string | undefined> {
  const row = await db
    .select()
    .from(associationConfig)
    .where(eq(associationConfig.key, 'association_name'))
    .get()
  return row ? (JSON.parse(row.value) as string) : undefined
}

describe('ensureInstancePreset — association_name seeding', () => {
  beforeEach(async () => {
    await applyMigrations()
  })

  it('lets ASSOCIATION_NAME override the migration placeholder on first registration', async () => {
    const db = getDb(env.DB)
    // migration 0001 pre-seeds association_name = "My Association"
    expect(await getName(db)).toBe('My Association')

    await ensureInstancePreset(
      { ...testEnv, ASSOCIATION_NAME: 'Prairie Policy Alliance' } as never,
      db,
    )

    expect(await getName(db)).toBe('Prairie Policy Alliance')
  })

  it('does not overwrite a name set after first registration (e.g. a UI edit)', async () => {
    const db = getDb(env.DB)
    await ensureInstancePreset({ ...testEnv, ASSOCIATION_NAME: 'Initial Name' } as never, db)

    // admin renames in the UI
    await db
      .update(associationConfig)
      .set({ value: JSON.stringify('Admin Edited Name') })
      .where(eq(associationConfig.key, 'association_name'))

    // a later ensureInstancePreset call (config load, cron, etc.) must not clobber it
    await ensureInstancePreset({ ...testEnv, ASSOCIATION_NAME: 'Initial Name' } as never, db)

    expect(await getName(db)).toBe('Admin Edited Name')
  })
})
