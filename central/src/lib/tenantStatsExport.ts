// Every tenant's daily engagement stats (tenant_stats) since a date, for a
// consumer Worker that binds to central's StatsApi entrypoint. There is no
// HTTP route for this: see StatsApi in index.ts.
import { asc, gte } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from '../db/schema'

type StatsRow = typeof schema.tenantStats.$inferSelect

/**
 * One tenant's stats for one day: every tenant_stats column, with
 * `excluded_json` parsed into `excluded` (the user-attributable metrics
 * recomputed without configured internal domains, keyed by snake_case metric
 * name; null when the row has none or it can't be read).
 */
export type TenantStatsDay = Omit<StatsRow, 'excludedJson'> & {
  excluded: Record<string, number> | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Parse `excluded_json`, keeping only numeric entries. Unreadable → null, so one bad row never fails the call. */
function parseExcluded(raw: string | null): Record<string, number> | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/**
 * Rows whose stat_date is on or after `since` (a "YYYY-MM-DD" UTC date),
 * ordered by tenant, then day. Throws on any other `since` format.
 */
export async function tenantStatsSince(
  db: DrizzleD1Database<typeof schema>,
  since: string,
): Promise<TenantStatsDay[]> {
  if (typeof since !== 'string' || !DATE.test(since)) {
    throw new TypeError('since must be a YYYY-MM-DD date')
  }
  const t = schema.tenantStats
  const rows = await db
    .select()
    .from(t)
    .where(gte(t.statDate, since))
    .orderBy(asc(t.tenantId), asc(t.statDate))
    .all()
  return rows.map(({ excludedJson, ...rest }) => ({ ...rest, excluded: parseExcluded(excludedJson) }))
}
