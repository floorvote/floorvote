import type { DemoSeed } from './types'
import { NJ_COUNTY_CLERKS_SEED } from './njCountyClerks'
import { LAKE_MICHIGAN_SEED } from './lakeMichigan'

export type { DemoSeed } from './types'

export const DEMO_SEEDS: Record<string, DemoSeed> = {
  'nj-county-clerks': NJ_COUNTY_CLERKS_SEED,
  'lake-michigan': LAKE_MICHIGAN_SEED,
}

/** Tenants deployed before DEMO_SEED existed keep working. */
export const DEFAULT_DEMO_SEED = 'nj-county-clerks'

export function resolveDemoSeed(slug: string | undefined): DemoSeed {
  const seed = DEMO_SEEDS[slug ?? DEFAULT_DEMO_SEED]
  if (!seed) throw new Error(`Unknown DEMO_SEED "${slug}"`)
  return seed
}
