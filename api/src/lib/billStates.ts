import { eq } from 'drizzle-orm'
import type { AppDb } from '../types'
import { associationConfig, bills } from '../db/schema'

// How long a tenant's states-with-bills list is reused. Which states an
// instance has bills in changes only when coverage is widened and the first
// bill from a new state syncs in, so a quarter hour of lag is invisible. The
// list is read with a scan of `bills` (no index leads with state), which is too
// much to pay on every facet request.
export const BILL_STATES_TTL_MS = 15 * 60_000

// One entry per tenant, held for the life of the isolate.
const cache = new Map<string, { loadedAt: number; states: string[] }>()
// The read in progress, per tenant: facet requests that arrive while it runs
// wait on it instead of each starting their own scan.
const loading = new Map<string, Promise<string[]>>()

/** Drop every cached list. For tests, which reset the database under the cache. */
export function clearBillStatesCache(): void {
  cache.clear()
  loading.clear()
}

/**
 * Whether the instance's coverage is `*`, read the way GET /config reports it:
 * a STATE-scoped instance is never `*`, and a missing or unparseable saved list
 * reports no states, so it isn't either.
 */
async function coversAllStates(db: AppDb, state: string | undefined): Promise<boolean> {
  if (state) return false
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'state_coverage')).get()
  if (!row) return false
  try {
    const coverage = JSON.parse(row.value) as unknown
    return Array.isArray(coverage) && coverage.includes('*')
  } catch {
    return false
  }
}

/**
 * Every state the instance has bills in, sorted, for the web app to resolve `*`
 * coverage to. Undefined, with no query against `bills`, when coverage is an
 * explicit list: the web app already knows those states. Otherwise from the
 * isolate's cache while it is fresh, else read once (shared by every caller that
 * arrives meanwhile). A failed read is not cached.
 */
export async function billStatesForWildcard(db: AppDb, tenantKey: string, state: string | undefined): Promise<string[] | undefined> {
  if (!(await coversAllStates(db, state))) return undefined

  const cached = cache.get(tenantKey)
  if (cached && Date.now() - cached.loadedAt < BILL_STATES_TTL_MS) return cached.states
  const inFlight = loading.get(tenantKey)
  if (inFlight) return inFlight

  const read = db.selectDistinct({ state: bills.state }).from(bills).all()
    .then(rows => {
      const states = rows.map(r => r.state).sort()
      cache.set(tenantKey, { loadedAt: Date.now(), states })
      return states
    })
    .finally(() => loading.delete(tenantKey))
  loading.set(tenantKey, read)
  return read
}
