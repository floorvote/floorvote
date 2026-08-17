import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { applyMigrations, resetDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { ensureAssociationName } from '../../src/lib/associationName'
import { associationConfig } from '../../src/db/schema'

const testEnv = { ...env, TENANT_ID: 'nj-test' }

async function getName(db: ReturnType<typeof getDb>): Promise<string | undefined> {
  const row = await db
    .select()
    .from(associationConfig)
    .where(eq(associationConfig.key, 'association_name'))
    .get()
  return row ? (JSON.parse(row.value) as string) : undefined
}

describe('ensureAssociationName', () => {
  beforeEach(async () => {
    // resetDb first: D1 state persists across tests within a file, and other
    // tests in this describe leave an edited association_name behind.
    await resetDb()
    await applyMigrations()
  })

  it('replaces the migration placeholder with ASSOCIATION_NAME', async () => {
    const db = getDb(env.DB)
    expect(await getName(db)).toBe('My Association')
    await ensureAssociationName({ ...testEnv, ASSOCIATION_NAME: 'Prairie Policy Alliance' } as never, db)
    expect(await getName(db)).toBe('Prairie Policy Alliance')
  })

  it('does not clobber an admin-edited name on later calls', async () => {
    const db = getDb(env.DB)
    await ensureAssociationName({ ...testEnv, ASSOCIATION_NAME: 'Initial Name' } as never, db)
    await db
      .update(associationConfig)
      .set({ value: JSON.stringify('Renamed By Admin') })
      .where(eq(associationConfig.key, 'association_name'))
    // Every GET /config calls this; it must be idempotent against a real edit.
    await ensureAssociationName({ ...testEnv, ASSOCIATION_NAME: 'Initial Name' } as never, db)
    expect(await getName(db)).toBe('Renamed By Admin')
  })

  it('no-ops when ASSOCIATION_NAME is unset', async () => {
    const db = getDb(env.DB)
    await ensureAssociationName({ ...testEnv, ASSOCIATION_NAME: undefined } as never, db)
    expect(await getName(db)).toBe('My Association')
  })
})
