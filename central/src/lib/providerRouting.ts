import { eq } from 'drizzle-orm'
import { bills, sourceRecords } from '../db/schema'
import { DEFAULT_PROVIDER_ID, PROVIDERS, type Provider } from '../providers'
import { providerEnv } from './providerContext'
import type { Env, Db } from '../types'

/**
 * Which provider wrote a bill, by id. A snapshot provider stores the bill's raw
 * record before the bill is ever queued; the bill row's own `source` column
 * covers a bill whose record has gone missing, so it still never reaches
 * LegiScan.
 */
export async function billProviderId(db: Db, billId: number): Promise<string> {
  const rec = await db.select({ source: sourceRecords.source }).from(sourceRecords)
    .where(eq(sourceRecords.billId, billId)).get()
  if (rec) return rec.source
  const bill = await db.select({ source: bills.source }).from(bills).where(eq(bills.billId, billId)).get()
  return bill?.source ?? DEFAULT_PROVIDER_ID
}

/** Whether this deployment is configured to read a provider. One without `enabled` is always on. */
export function providerEnabled(provider: Provider, env: Env): boolean {
  return provider.enabled?.(providerEnv(provider, env)) ?? true
}

/**
 * States this deployment reads from a provider other than LegiScan, which the
 * LegiScan sync leaves alone. Env vars turn those providers on until state
 * ownership moves to a table (#292).
 */
export function directStates(env: Env): Set<string> {
  return new Set(PROVIDERS.filter(p => p.states && providerEnabled(p, env)).flatMap(p => p.states ?? []))
}

/** The queue a provider's bills are ingested from: its own binding when it declares one that is bound. */
export function ingestQueueFor(provider: Provider, env: Env): Queue {
  return (provider.ingestQueue ? env[provider.ingestQueue] as Queue | undefined : undefined) ?? env.INGESTOR_QUEUE
}
