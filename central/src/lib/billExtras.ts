import { and, eq } from 'drizzle-orm'
import { billExtras } from '../db/schema'
import type { CentralMeasure, Provider, VocabularyExtra } from '../providers'
import type { BillExtras } from '../../../shared/providerExtras'
import type { Db } from '../types'

/**
 * Provider extras (`ProviderVocabulary.extras`): fields only one provider
 * publishes, stored per bill in `bill_extras` and sent in the bill's rich
 * detail with the vocabulary's labels. Display only, so nothing here feeds
 * change detection, notifications, sorting, filtering, or AI.
 */

/** Rows per insert: four bound parameters each, under D1's limit of 100. */
const INSERT_CHUNK = 20

/**
 * Replace a bill's stored extras with the measure's. Every provider's rows go,
 * so a bill that changed provider keeps none of the old provider's. A value
 * whose key the vocabulary doesn't declare, or that doesn't fit its display
 * type, is dropped with a warning rather than shown wrong.
 */
export async function replaceBillExtras(db: Db, measure: CentralMeasure, provider: Provider): Promise<void> {
  await db.delete(billExtras).where(eq(billExtras.billId, measure.bill_id))
  const declared = provider.vocabulary.extras ?? {}
  const rows: (typeof billExtras.$inferInsert)[] = []
  for (const [key, raw] of Object.entries(measure.extras ?? {})) {
    const value = raw?.trim()
    if (!value) continue
    const extra = Object.hasOwn(declared, key) ? declared[key] : undefined
    if (!extra) {
      console.warn(`[extras] ${provider.id} bill ${measure.bill_id}: dropped "${key}", which its vocabulary doesn't declare`)
      continue
    }
    if (!fitsDisplay(extra, value)) {
      console.warn(`[extras] ${provider.id} bill ${measure.bill_id}: dropped "${key}", whose value isn't a ${extra.display}`)
      continue
    }
    rows.push({ billId: measure.bill_id, provider: provider.id, key, value })
  }
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(billExtras).values(rows.slice(i, i + INSERT_CHUNK))
  }
}

/** Whether a value is what its display type promises: a real YYYY-MM-DD date, or an http(s) URL. */
function fitsDisplay(extra: VocabularyExtra, value: string): boolean {
  if (extra.display === 'date') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
  }
  if (extra.display === 'link') {
    try {
      const { protocol } = new URL(value)
      return protocol === 'https:' || protocol === 'http:'
    } catch {
      return false
    }
  }
  return true
}

/**
 * A bill's extras as the bill detail sends them: its provider's stored values,
 * in vocabulary order, with labels, explainers, and display types. Null when
 * there are none. A stored key the vocabulary no longer declares is skipped.
 */
export async function billExtrasDetail(db: Db, billId: number, provider: Provider): Promise<BillExtras | null> {
  const rows = await db.select({ key: billExtras.key, value: billExtras.value }).from(billExtras)
    .where(and(eq(billExtras.billId, billId), eq(billExtras.provider, provider.id))).all()
  if (rows.length === 0) return null
  const values = new Map(rows.map(r => [r.key, r.value]))
  const fields = Object.entries(provider.vocabulary.extras ?? {}).flatMap(([key, extra]) => {
    const value = values.get(key)
    return value === undefined ? [] : [{ key, label: extra.label, explainer: extra.explainer ?? null, display: extra.display, value }]
  })
  return fields.length > 0 ? { providerName: provider.displayName, fields } : null
}
