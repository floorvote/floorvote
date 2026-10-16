import { eq, sql } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import { centralFetch } from './centralFetch'
import { nowDb } from './dbTime'
import type { AppDb, Env, TenantQueueMessage } from '../types'

/**
 * Delivery check for scripts/verify-instance.sh.
 *
 * The script asks central to send this instance one already-stored bill through
 * the real delivery path. The message carries `probe`, a nonce the script chose,
 * which makes the consumer record its arrival and stop: no bill row, no feed
 * event, no analysis. So the check proves the queue consumer is attached and the
 * CENTRAL binding can read from central, and leaves which bills the instance
 * tracks exactly as it was.
 *
 * Only the latest probe is kept, in one association_config row.
 */
const KEY = 'delivery_probe'

export interface DeliveryProbeRecord {
  nonce: string
  billId: string
  receivedAt: string
  /** HTTP status central gave when the instance read the bill back; 0 if the call failed outright. */
  readStatus: number
}

export async function recordDeliveryProbe(msg: TenantQueueMessage, env: Env, db: AppDb): Promise<void> {
  let readStatus = 0
  try {
    const res = await centralFetch(env, `/bills/${msg.billId}`)
    readStatus = res.status
    await res.body?.cancel()
  } catch (err) {
    console.warn(`[probe] could not read ${msg.billId} from central:`, err)
  }
  const record: DeliveryProbeRecord = { nonce: msg.probe ?? '', billId: msg.billId, receivedAt: nowDb(), readStatus }
  await db.insert(associationConfig)
    .values({ key: KEY, value: JSON.stringify(record) })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: sql`excluded.value` } })
}

export async function readDeliveryProbe(db: AppDb): Promise<DeliveryProbeRecord | null> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, KEY)).get()
  if (!row) return null
  try { return JSON.parse(row.value) as DeliveryProbeRecord } catch { return null }
}
