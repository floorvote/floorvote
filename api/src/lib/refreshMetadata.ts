import { isNotNull } from 'drizzle-orm'
import { bills } from '../db/schema'
import type { Env, AppDb } from '../types'

export async function refreshMetadata(env: Env, db: AppDb): Promise<{ queued: number }> {
  if (!env.BILL_QUEUE) throw new Error('Queue not configured')
  const rows = await db.select({ externalId: bills.externalId }).from(bills).where(isNotNull(bills.externalId)).all()
  const BATCH_SIZE = 100
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await env.BILL_QUEUE.sendBatch(
      rows.slice(i, i + BATCH_SIZE)
        .filter(r => r.externalId)
        .map(r => ({ body: { tenantId: env.TENANT_ID, billId: r.externalId!, metadataOnly: true } }))
    )
  }
  return { queued: rows.length }
}
