import { eq, sql } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import { PRESETS } from './presets'
import type { AppDb, Env } from '../types'

export async function applyPresetConfig(db: AppDb, slug: string): Promise<boolean> {
  const preset = PRESETS[slug]
  if (!preset) return false

  const configUpdates: Array<{ key: string; value: string }> = [
    { key: 'instance_preset', value: JSON.stringify(slug) },
    { key: 'ai_context', value: JSON.stringify(preset.aiContext) },
    { key: 'relevance_question', value: JSON.stringify(preset.relevanceQuestion) },
    { key: 'tag_taxonomy', value: JSON.stringify(preset.taxonomy) },
    { key: 'keywords', value: JSON.stringify(preset.keywords) },
  ]

  for (const { key, value } of configUpdates) {
    await db
      .insert(associationConfig)
      .values({ key, value })
      .onConflictDoUpdate({
        target: associationConfig.key,
        set: { value: sql`excluded.value` },
      })
  }

  return true
}

/**
 * Returned by `ensureInstancePreset` for a DEMO_MODE tenant. Deliberately not a
 * key in PRESETS: a demo tenant's AI config comes from its seed, not a preset,
 * but it *is* configured, so callers that gate on "config in place" (the AI gate
 * in queue/processor.ts) must still see a truthy value.
 */
export const DEMO_SEED_PRESET = 'demo-seed'

export async function ensureInstancePreset(env: Env, db: AppDb): Promise<string | null> {
  // A DEMO_MODE tenant owns ai_context, relevance_question, tag_taxonomy, and
  // keywords through its seed (api/src/lib/demoSeeds/), and runDemoReset writes
  // no instance_preset row — so on a fresh demo tenant the bootstrap branch below
  // would fire on the very first GET /config and overwrite all four with preset
  // values. That is a live hazard, not a theoretical one: tenants.md recommends
  // setting INSTANCE_PRESET on every tenant and demo.md says to deploy a demo
  // "exactly as in Adding tenants". The damage self-heals at the next reset
  // with no error logged anywhere, so a new demo would spend its first day on the
  // wrong taxonomy. Write nothing here; the seed is the only writer.
  if (env.DEMO_MODE === 'true') return DEMO_SEED_PRESET

  const row = await db
    .select()
    .from(associationConfig)
    .where(eq(associationConfig.key, 'instance_preset'))
    .get()

  if (row) {
    try {
      return JSON.parse(row.value) as string
    } catch {
      return row.value
    }
  }

  const fallbackSlug = env.INSTANCE_PRESET
  if (!fallbackSlug) return null

  const applied = await applyPresetConfig(db, fallbackSlug)
  if (!applied) {
    console.error(`Unknown INSTANCE_PRESET "${fallbackSlug}" for tenant ${env.TENANT_ID}`)
    return null
  }

  // Seed association_name from env on first preset application. This must override the
  // migration's "My Association" placeholder (0001_initial.sql) — hence onConflictDoUpdate,
  // not onConflictDoNothing. Safe because this branch runs only once, on the first
  // registration (when no instance_preset row exists yet); later UI edits to the name are
  // preserved because subsequent calls return early above.
  if (env.ASSOCIATION_NAME) {
    await db
      .insert(associationConfig)
      .values({ key: 'association_name', value: JSON.stringify(env.ASSOCIATION_NAME) })
      .onConflictDoUpdate({
        target: associationConfig.key,
        set: { value: sql`excluded.value` },
      })
  }

  return fallbackSlug
}
