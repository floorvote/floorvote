import type { BillProvider } from './types'
import type { Env, CentralDb } from '../types'
import { createOpenStatesProvider } from './openstates'
import { createLegiscanProvider } from './legiscan'
import { sql } from 'drizzle-orm'
import { apiCallLog } from '../db/schema'

export type { BillProvider } from './types'
export { deriveStatus } from './openstates'

export function getProvider(env: Env, db: CentralDb): BillProvider {
  const providerName = env.BILL_PROVIDER ?? 'legiscan'

  const trackCall = () => {
    const date = new Date().toISOString().split('T')[0] // ts-write-ok: date-only (YYYY-MM-DD) key, format-agnostic
    db.insert(apiCallLog)
      .values({ date, provider: providerName, callCount: 1 })
      .onConflictDoUpdate({
        target: [apiCallLog.date, apiCallLog.provider],
        set: { callCount: sql`${apiCallLog.callCount} + 1` },
      })
      .catch(err => console.error('[rate-limit] failed to log API call:', err))
  }

  if (providerName === 'legiscan') {
    return createLegiscanProvider(env.LEGISCAN_API_KEY)
  }
  return createOpenStatesProvider(env.OPENSTATES_API_KEY, trackCall)
}
