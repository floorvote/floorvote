import { inArray } from 'drizzle-orm'
import { findProvider, type Provider } from '../providers'
import { bills } from '../db/schema'
import { providerEnv } from './providerContext'
import type { Db, Env } from '../types'

/** Whether this deployment has what a provider needs to run, such as its API key. One without `configured` needs nothing. */
export function providerConfigured(provider: Provider, env: Env): boolean {
  return provider.configured?.(providerEnv(provider, env)) ?? true
}

/** The queue a provider's bills are ingested from: its own binding, when it declares one and it is bound. */
export function ingestQueueFor(provider: Provider, env: Env): Queue {
  return (provider.ingestQueue ? env[provider.ingestQueue] as Queue | undefined : undefined) ?? env.INGESTOR_QUEUE
}

/** The queue for a provider named by id: `ingestQueueFor`, or the shared queue for an id central doesn't know. */
export function ingestQueueForId(providerId: string | null | undefined, env: Env): Queue {
  const provider = findProvider(providerId)
  return provider ? ingestQueueFor(provider, env) : env.INGESTOR_QUEUE
}

/** D1 binds at most 100 parameters, so a lookup by bill id reads this many at a time. */
const LOOKUP_CHUNK = 90

/**
 * The queue each bill's ingest goes to, by the provider on its row: the bills of one provider
 * share a group, and so do the bills of every provider that falls back to the shared queue.
 * A bill with no row, or a provider central doesn't know, goes to the shared queue, as LegiScan's does.
 * Groups keep the order bills were given in, and so do the bills within one.
 */
export async function groupByIngestQueue(billIds: number[], env: Env, db: Db): Promise<{ queue: Queue; billIds: number[] }[]> {
  const providerOf = new Map<number, string>()
  for (let i = 0; i < billIds.length; i += LOOKUP_CHUNK) {
    const rows = await db.select({ billId: bills.billId, provider: bills.provider }).from(bills)
      .where(inArray(bills.billId, billIds.slice(i, i + LOOKUP_CHUNK))).all()
    for (const r of rows) providerOf.set(r.billId, r.provider)
  }
  const groups = new Map<Queue, number[]>()
  for (const billId of billIds) {
    const queue = ingestQueueForId(providerOf.get(billId), env)
    const ids = groups.get(queue)
    if (ids) ids.push(billId)
    else groups.set(queue, [billId])
  }
  return [...groups].map(([queue, ids]) => ({ queue, billIds: ids }))
}

/** The queue one bill's ingest goes to: `groupByIngestQueue` for a single bill. */
export async function ingestQueueForBill(billId: number, env: Env, db: Db): Promise<Queue> {
  return (await groupByIngestQueue([billId], env, db))[0].queue
}
