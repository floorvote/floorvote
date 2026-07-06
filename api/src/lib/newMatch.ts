import { eq } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import type { AppDb } from '../types'

/**
 * Minimum relevance score for a keyword match to surface in the "New matches"
 * worklist and the digest's new-bills section. Stored in association_config as
 * `new_match_min_relevance`. Default 0 — every keyword match surfaces. Invalid or
 * negative values are treated as 0. The feed `bill_matched` event is NOT gated by
 * this threshold (the analyzed-scope feed is the comprehensive match record).
 */
export async function getNewMatchMinRelevance(db: AppDb): Promise<number> {
  const row = await db.select().from(associationConfig)
    .where(eq(associationConfig.key, 'new_match_min_relevance')).get()
  if (!row?.value) return 0
  let raw = row.value
  try {
    const parsed = JSON.parse(row.value)
    if (typeof parsed === 'number' || typeof parsed === 'string') raw = String(parsed)
  } catch { /* plain string */ }
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}
