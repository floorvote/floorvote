import { eq } from 'drizzle-orm'
import { bills, billTenants } from '../db/schema'
import { getProvider } from '../providers/index'
import { nowDb } from '../lib/dbTime'
import type { NormalizedBill } from '../providers/types'
import type { Env, CentralDb, IngestorQueueMessage } from '../types'
import { getTenantQueue } from '../lib/tenantQueue'
import { safeFetch } from '../lib/safeFetch'

function billUuid(billId: string): string {
  return billId.replace('ocd-bill/', '')
}

export async function processIngestorQueue(
  batch: MessageBatch<IngestorQueueMessage>,
  env: Env,
  db: CentralDb,
): Promise<void> {
  const provider = getProvider(env, db)
  for (const message of batch.messages) {
    try {
      await processSingleBill(message.body, env, db, provider)
      message.ack()
    } catch (err) {
      console.error('[processor] failed for billId', message.body.billId, err)
      message.retry()
    }
  }
}

export async function processSingleBill(
  msg: IngestorQueueMessage,
  env: Env,
  db: CentralDb,
  provider: { fetchBillDetail: (id: string) => Promise<NormalizedBill> },
): Promise<void> {
  const now = nowDb()

  const stored = await db.select({ updatedAt: bills.updatedAt, textR2Key: bills.textR2Key, providerData: bills.providerData })
    .from(bills)
    .where(eq(bills.billId, msg.billId))
    .get()

  const bill = await provider.fetchBillDetail(msg.billId)

  if (stored?.updatedAt === bill.updatedAt && stored?.textR2Key) {
    await notifyTenants(msg.billId, env, db, now)
    return
  }

  const uuid = billUuid(msg.billId)
  const sortedVersions = [...bill.versions].sort((a, b) => a.date.localeCompare(b.date))
  let preferredR2Key: string | null = null
  let preferredTextHash: string | null = null

  for (const version of sortedVersions) {
    for (const link of version.links) {
      const isHtml = link.mediaType.includes('html') || link.mediaType.includes('text')
      const ext = isHtml ? 'html' : 'pdf'
      const r2Key = `bills/${uuid}/${version.id}.${ext}`

      try {
        const existing = await env.BILLS_BUCKET.head(r2Key)
        if (existing) {
          preferredR2Key = r2Key
          preferredTextHash = existing.customMetadata?.textHash ?? null
          continue
        }

        const res = await safeFetch(link.url)
        if (!res.ok) {
          console.error(`[processor] failed to fetch version ${version.id} from ${link.url}: ${res.status}`)
          continue
        }

        const body = isHtml ? await res.text() : await res.arrayBuffer()
        const hashBuffer = await crypto.subtle.digest('SHA-256', typeof body === 'string' ? new TextEncoder().encode(body) : body)
        const textHash = [...new Uint8Array(hashBuffer)].map(b => b.toString(16).padStart(2, '0')).join('')

        await env.BILLS_BUCKET.put(r2Key, body, {
          customMetadata: { textHash },
          httpMetadata: { contentType: isHtml ? 'text/html; charset=utf-8' : 'application/pdf' },
        })

        preferredR2Key = r2Key
        preferredTextHash = textHash
      } catch (err) {
        console.error(`[processor] failed to store version ${version.id} for bill ${msg.billId}:`, err)
      }
    }
  }

  for (const doc of bill.documents ?? []) {
    for (const link of doc.links) {
      const ext = link.mediaType.includes('pdf') ? 'pdf' : 'html'
      const r2Key = `bills/${uuid}/docs/${doc.id}.${ext}`
      try {
        const existing = await env.BILLS_BUCKET.head(r2Key)
        if (existing) continue
        const res = await safeFetch(link.url)
        if (!res.ok) continue
        const body = ext === 'html' ? await res.text() : await res.arrayBuffer()
        await env.BILLS_BUCKET.put(r2Key, body, {
          httpMetadata: { contentType: link.mediaType },
        })
      } catch (err) {
        console.error(`[processor] failed to store doc ${doc.id} for bill ${msg.billId}:`, err)
      }
    }
  }

  await db.update(bills)
    .set({
      providerData: JSON.stringify(bill),
      textR2Key: preferredR2Key,
      textHash: preferredTextHash,
      status: bill.status,
      statusDate: bill.statusDate,
      lastAction: bill.lastAction,
      lastActionDate: bill.lastActionDate,
      openstatesUrl: bill.url,
      stateUrl: bill.stateUrl,
      abstract: bill.abstract,
      updatedAt: bill.updatedAt,
    })
    .where(eq(bills.billId, msg.billId))

  await notifyTenants(msg.billId, env, db, now)
}

async function notifyTenants(billId: string, env: Env, db: CentralDb, now: string): Promise<void> {
  const matchingTenants = await db
    .select({ tenantId: billTenants.tenantId })
    .from(billTenants)
    .where(eq(billTenants.billId, billId))
    .all()

  for (const t of matchingTenants) {
    const queue = getTenantQueue(env, t.tenantId)
    if (queue) {
      await queue.send({ tenantId: t.tenantId, billId })
    } else {
      console.error(`[processor] no queue binding for tenant ${t.tenantId}`)
    }
  }

  if (matchingTenants.length > 0) {
    await db.update(billTenants)
      .set({ notifiedAt: now })
      .where(eq(billTenants.billId, billId))
  }
}
