import { eq } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import { DEFAULT_MODULES, type ModulesConfig } from '../../../shared/modules'
import type { AppDb } from '../types'

/**
 * The instance's modules as saved in association_config. One that never saved any, a new instance, reads as
 * DEFAULT_MODULES. A saved value that isn't an object reads as none on, since someone saved it.
 */
export async function readModules(db: AppDb): Promise<ModulesConfig> {
  const row = await db.select({ value: associationConfig.value }).from(associationConfig).where(eq(associationConfig.key, 'modules')).get()
  if (!row) return DEFAULT_MODULES
  try {
    const parsed = JSON.parse(row.value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ModulesConfig : {}
  } catch {
    return {}
  }
}
