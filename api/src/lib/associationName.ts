import { eq, sql } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import { readConfigString } from './configValue'
import { ASSOCIATION_NAME_PLACEHOLDER } from '../../../shared/aiDefaults'
import type { AppDb, Env } from '../types'

/**
 * Seed association_name from the ASSOCIATION_NAME env var, overwriting only the
 * migration placeholder from 0001_initial.sql.
 *
 * Rescued from the retired ensureInstancePreset, where "run once" was implied by an
 * early return on an existing instance_preset row. That guard is gone, so the
 * placeholder check is now explicit — this runs on every GET /config and must never
 * overwrite a name an admin has edited.
 *
 * Load-bearing: the default AI context interpolates this name into every prompt,
 * so a tenant left on the placeholder would open each prompt with "You are
 * analyzing a bill for My Association."
 */
export async function ensureAssociationName(env: Env, db: AppDb): Promise<void> {
  if (!env.ASSOCIATION_NAME) return

  const row = await db
    .select()
    .from(associationConfig)
    .where(eq(associationConfig.key, 'association_name'))
    .get()

  const current = readConfigString(row)
  if (current && current !== ASSOCIATION_NAME_PLACEHOLDER) return

  await db
    .insert(associationConfig)
    .values({ key: 'association_name', value: JSON.stringify(env.ASSOCIATION_NAME) })
    .onConflictDoUpdate({
      target: associationConfig.key,
      set: { value: sql`excluded.value` },
    })
}
