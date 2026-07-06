import { isNotNull, and, like } from 'drizzle-orm'
import { bills } from '../db/schema'
import { centralFetch } from './centralFetch'
import type { AppDb, Env } from '../types'

// Parse a tenant bill's externalId ('legiscan:123') to its numeric LegiScan id,
// or null for non-legiscan / malformed ids.
export function parseLegiScanId(externalId: string | null | undefined): number | null {
  if (!externalId || !externalId.startsWith('legiscan:')) return null
  const n = parseInt(externalId.slice('legiscan:'.length), 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

// The numeric LegiScan ids of priority-set, legiscan-sourced bills.
export async function collectPriorityLegiscanIds(db: AppDb): Promise<number[]> {
  const rows = await db.select({ externalId: bills.externalId })
    .from(bills)
    .where(and(isNotNull(bills.priority), like(bills.externalId, 'legiscan:%')))
    .all()
  return rows
    .map(r => parseLegiScanId(r.externalId))
    .filter((n): n is number => n !== null)
}

// Ask central to re-deliver the given bills WITH calendar blocks (targeted reprocess).
// Errors are logged, not thrown — safe to call inside waitUntil / fire-and-forget.
export async function backfillCalendar(env: Env, legiscanIds: number[]): Promise<void> {
  if (legiscanIds.length === 0) return
  try {
    const res = await centralFetch(env, `/tenants/reprocess/${env.TENANT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ billIds: legiscanIds }),
    })
    if (!res.ok) console.error(`[calendarBackfill] central reprocess ${res.status}`)
  } catch (err) {
    console.error('[calendarBackfill] failed:', err)
  }
}
