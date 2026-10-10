import { and, eq, sql } from 'drizzle-orm'
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
 * whose key the vocabulary doesn't declare, that isn't a string, or that
 * doesn't fit its display type, is dropped with a warning rather than shown
 * wrong. Checking a value never throws: this runs mid-ingest, and a throw
 * here would skip the rest of the bill's ingest and its tenant notifications.
 *
 * The delete and inserts are one batch, so a failure can't leave the bill
 * with no extras, and an insert that meets an overlapping ingest's row
 * updates it instead of failing.
 */
export async function replaceBillExtras(db: Db, measure: CentralMeasure, provider: Provider): Promise<void> {
  const rows = extraRows(measure, provider)
  const inserts = []
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    inserts.push(db.insert(billExtras).values(rows.slice(i, i + INSERT_CHUNK)).onConflictDoUpdate({
      target: [billExtras.billId, billExtras.provider, billExtras.key],
      set: { value: sql`excluded.value` },
    }))
  }
  await db.batch([db.delete(billExtras).where(eq(billExtras.billId, measure.bill_id)), ...inserts])
}

/** The measure's extras that pass every check, as rows to store. */
function extraRows(measure: CentralMeasure, provider: Provider): (typeof billExtras.$inferInsert)[] {
  const declared = provider.vocabulary.extras ?? {}
  const rows: (typeof billExtras.$inferInsert)[] = []
  const drop = (key: string, why: string) =>
    console.warn(`[extras] ${provider.id} bill ${measure.bill_id}: dropped "${key}", ${why}`)
  for (const [key, raw] of Object.entries(measure.extras ?? {})) {
    if (raw == null) continue
    if (typeof raw !== 'string') {
      drop(key, `whose value is a ${typeof raw}, not a string`)
      continue
    }
    const value = raw.trim()
    if (!value) continue
    const extra = Object.hasOwn(declared, key) ? declared[key] : undefined
    if (!extra) {
      drop(key, 'which its vocabulary doesn\'t declare')
      continue
    }
    let fits = false
    try {
      fits = fitsDisplay(extra, value)
    } catch {
      // A check that throws counts as a value that doesn't fit.
    }
    if (!fits) {
      drop(key, `whose value isn't a ${extra.display}`)
      continue
    }
    rows.push({ billId: measure.bill_id, provider: provider.id, key, value })
  }
  return rows
}

/** Whether a value is what its display type promises: a real YYYY-MM-DD date, or an http(s) URL. */
function fitsDisplay(extra: VocabularyExtra, value: string): boolean {
  if (extra.display === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    // Rules out 2026-13-01, 2026-02-30, and 0000-00-00, which either parse
    // to an invalid date or roll over to another day.
    const d = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)
  }
  if (extra.display === 'link') {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  }
  return true
}

/**
 * A bill's extras as the bill detail sends them: its provider's stored values,
 * in vocabulary order, with labels, explainers, and display types. Null when
 * there are none. A stored key the vocabulary no longer declares is skipped.
 */
export async function billExtrasDetail(db: Db, billId: number, provider: Provider): Promise<BillExtras | null> {
  const declared = Object.entries(provider.vocabulary.extras ?? {})
  // A provider with no extras (LegiScan) skips the read.
  if (declared.length === 0) return null
  const rows = await db.select({ key: billExtras.key, value: billExtras.value }).from(billExtras)
    .where(and(eq(billExtras.billId, billId), eq(billExtras.provider, provider.id))).all()
  if (rows.length === 0) return null
  const values = new Map(rows.map(r => [r.key, r.value]))
  const fields = declared.flatMap(([key, extra]) => {
    const value = values.get(key)
    return value === undefined ? [] : [{ key, label: extra.label, explainer: extra.explainer ?? null, display: extra.display, value }]
  })
  return fields.length > 0 ? { providerName: provider.displayName, fields } : null
}
