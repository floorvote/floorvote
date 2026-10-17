import { and, gte, sql } from 'drizzle-orm'
import { apiCallLog } from '../db/schema'
import type { Db } from '../types'

/**
 * Only LegiScan's calls. Other providers' calls are logged to api_call_log
 * too, as '<provider id>:<operation>' (such as 'lims:Members'), but they don't
 * count against the LegiScan monthly budget. LegiScan's own operation names
 * (getBill, getMasterListRaw, ...) have no colon.
 */
export const legiscanCallsOnly = sql`${apiCallLog.callType} NOT LIKE '%:%'`

/**
 * The first of `now`'s month at midnight UTC, in the stored format. Rows
 * logged since nowDb() carry 'YYYY-MM-DD HH:MM:SS', and older ones ISO
 * timestamps. Both sort at or after this string from the first second of the
 * month, where an ISO bound ('...T00:00:00.000Z') sorts after every
 * space-format row of the first day and leaves that day out.
 */
export function monthStartDb(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01 00:00:00`
}

/** This month's LegiScan calls: the count the Budget page shows against `legiscan_monthly_limit`. */
export async function legiscanCallsThisMonth(db: Db, now: Date = new Date()): Promise<number> {
  const row = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(apiCallLog)
    .where(and(gte(apiCallLog.loggedAt, monthStartDb(now)), legiscanCallsOnly))
    .get()
  return Number(row?.n ?? 0)
}
