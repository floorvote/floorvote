import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { applyMigrations, resetDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { ensureInstancePreset, DEMO_SEED_PRESET } from '../../src/lib/instancePreset'
import { PRESETS } from '../../src/lib/presets'
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

describe('ensureInstancePreset — DEMO_MODE tenants', () => {
  beforeEach(async () => {
    // resetDb first: the describe above leaves an edited association_name behind,
    // and this block asserts on the untouched migration placeholder.
    await resetDb()
    await applyMigrations()
  })

  it('writes nothing on a demo tenant, not even association_name', async () => {
    const db = getDb(env.DB)
    // A fresh demo tenant has no instance_preset row (runDemoReset deletes it),
    // so without the demo guard this call takes the bootstrap branch.
    await ensureInstancePreset(
      { ...testEnv, DEMO_MODE: 'true', ASSOCIATION_NAME: 'Preset Name' } as never,
      db,
    )
    expect(await getName(db)).toBe('My Association') // untouched migration placeholder
    const preset = await db
      .select()
      .from(associationConfig)
      .where(eq(associationConfig.key, 'instance_preset'))
      .get()
    expect(preset).toBeUndefined()
  })

  it('returns a non-null sentinel so the queue AI gate stays open', async () => {
    // queue/processor.ts gates AI on a truthy return ("is this tenant's AI config
    // in place?"). A demo tenant's config comes from its seed, so the answer is
    // yes — returning null here would silently stop AI on every demo tenant.
    const db = getDb(env.DB)
    const result = await ensureInstancePreset({ ...testEnv, DEMO_MODE: 'true' } as never, db)
    expect(result).toBe(DEMO_SEED_PRESET)
    expect(PRESETS[DEMO_SEED_PRESET]).toBeUndefined() // never a real preset slug
  })
})
