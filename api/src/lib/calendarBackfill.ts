import { isNotNull, and, like } from 'drizzle-orm'
import { bills } from '../db/schema'
import { centralFetch } from './centralFetch'
import type { AppDb, Env } from '../types'
import { HANDLE_PREFIX, parseHandle } from '../../../shared/billHandle'

// Central's bill ids for the priority-set bills that have a handle.
export async function collectPriorityLegiscanIds(db: AppDb): Promise<number[]> {
  const rows = await db.select({ externalId: bills.externalId })
    .from(bills)
    .where(and(isNotNull(bills.priority), like(bills.externalId, `${HANDLE_PREFIX}%`)))
    .all()
  return rows
    .map(r => parseHandle(r.externalId))
    .filter((n): n is number => n !== null)
}

// Ask central to re-deliver the given bills WITH calendar blocks (targeted reprocess).
// Errors are logged, not thrown — safe to call inside waitUntil / fire-and-forget.
export async function backfillCalendar(env: Env, legiscanIds: number[]): Promise<void> {
  if (legiscanIds.length === 0) return
  // A demo's calendar is seeded, not backfilled. Skipping here keeps a visitor
  // action from generating central traffic and a queue message that the
  // processor's demo guard would only discard on the far side. Belt to that
  // guard's braces: the processor is what actually prevents the model call.
  if (env.DEMO_MODE === 'true') return
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
