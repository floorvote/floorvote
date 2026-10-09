import { eq } from 'drizzle-orm'
import { getBulkData, getCouncilPeriods } from '../lib/lims'
import { clean, councilPeriodName } from '../lib/lims-map'
import { limsBillId, limsSessionId } from '../lib/lims-ids'
import { sessions, billTenants, tenants } from '../db/schema'
import { trackLimsCall } from '../lib/lims-ingest'
import { nowDb } from '../lib/dbTime'
import { limsRecord, limsSessionValues, limsSource } from '../sources/lims'
import { runSourceSync, sourceQueue, storeRecords, type SourcePassReport } from './sync-sources'
import { applyMasterList } from './sync'
import type { SourceRecord } from '../sources/types'
import type { Env, Db } from '../types'

export { refreshCouncilPeriod } from '../sources/lims'

/** The DC Council LIMS sync (src/sources/lims.ts), through the common source sync. */
export function runLimsSync(env: Env, db: Db, opts: { force?: boolean } = {}): Promise<SourcePassReport[]> {
  return runSourceSync(limsSource, env, db, opts)
}

/** LIMS category id for each measure-number prefix (GET LegislationCategories). */
const CATEGORY_BY_PREFIX: Record<string, number> = {
  B: 1, PR: 6, CER: 6, CA: 12, GBM: 13, REPROG: 14, HFA: 15,
  RC: 16, ANC: 16, AU: 16, CFO: 16, IG: 16, HN: 18, HR: 19, AG: 26,
}

export interface LimsImportResult {
  imported: string[]
  notFound: string[]
  invalid: string[]
}

/**
 * Import specific LIMS measures, from any Council Period, for one tenant and
 * track them there as manual picks (so each gets a full ingest and AI analysis
 * whatever the tenant's keywords). The scheduled sync covers only the current
 * period and, for a year, the previous one; this is how a team pulls in older
 * measures it still works from (e.g. B25-0345, the Secure DC Omnibus) without
 * importing the whole period. One BulkData call per (period, category) group.
 */
export async function importLimsMeasures(
  env: Env,
  db: Db,
  tenantId: string,
  numbers: string[],
): Promise<LimsImportResult> {
  const tenant = await db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get()
  if (!tenant) throw new Error(`tenant ${tenantId} not found`)
  const apiKey = env.LIMS_API_KEY!
  const ctx = { today: nowDb().slice(0, 10), etHour: 0, force: true }
  const result: LimsImportResult = { imported: [], notFound: [], invalid: [] }

  // Group by (Council Period, category): one BulkData call each.
  const groups = new Map<string, { cp: number; category: number; numbers: Set<string> }>()
  for (const raw of numbers) {
    const number = clean(raw).toUpperCase()
    const m = /^([A-Z]+)(\d{1,2})-(\d{1,5})$/.exec(number)
    const category = m ? CATEGORY_BY_PREFIX[m[1]] : undefined
    if (!m || !category || limsBillId(number) === null) { result.invalid.push(raw); continue }
    const key = `${m[2]}:${category}`
    const g = groups.get(key) ?? { cp: Number(m[2]), category, numbers: new Set<string>() }
    // Normalise the sequence to LIMS's four-digit form ("B25-345" → "B25-0345").
    g.numbers.add(`${m[1]}${m[2]}-${m[3].padStart(4, '0')}`)
    groups.set(key, g)
  }
  if (groups.size === 0) return result

  const periods = new Map((await getCouncilPeriods(apiKey, () => trackLimsCall(db, 'CouncilPeriods', {})))
    .map(p => [p.councilPeriodId, p]))
  const queue = sourceQueue(limsSource, env)
  const covering = [{ tenantId, stateCoverage: tenant.stateCoverage, queueId: tenant.queueId ?? null }]

  for (const g of groups.values()) {
    const cp = periods.get(g.cp)
    if (!cp) { result.notFound.push(...g.numbers); continue }
    // Create the period's session if this central has never seen it. An existing
    // row is left alone, so importing from the current period changes nothing.
    await db.insert(sessions)
      .values(limsSessionValues(cp, 1, cp.endDate.slice(0, 10) < ctx.today ? 1 : 0))
      .onConflictDoNothing()
    const session = await db.select().from(sessions).where(eq(sessions.sessionId, limsSessionId(cp.councilPeriodId))).get()
    if (!session) throw new Error(`[lims-import] session for ${councilPeriodName(cp)} was not written`)

    const rows = await getBulkData(g.category, g.cp, apiKey,
      () => trackLimsCall(db, 'BulkData', { categoryId: g.category, councilPeriodId: g.cp, reason: 'import' }))
    const wanted = rows.filter(r => g.numbers.has(clean(r.legislationNumber)))
    const found = new Set(wanted.map(r => clean(r.legislationNumber)))
    result.notFound.push(...[...g.numbers].filter(n => !found.has(n)))
    if (wanted.length === 0) continue

    const records = (await Promise.all(wanted.map(limsRecord))).filter((r): r is SourceRecord => r !== null)
    const entries = await storeRecords(limsSource, session, records, db, ctx)
    const ids = records.map(r => r.billId)

    const queued = new Set(await applyMasterList(session, entries, covering, env, db, queue, { deferQueuedUpdates: true }))
    for (const billId of ids) {
      await db.insert(billTenants).values({ billId, tenantId, matchType: 'manual' })
        .onConflictDoUpdate({ target: [billTenants.billId, billTenants.tenantId], set: { matchType: 'manual' } })
    }
    const toQueue = ids.filter(id => !queued.has(id))
    for (let i = 0; i < toQueue.length; i += 100) {
      await queue.sendBatch(toQueue.slice(i, i + 100).map(billId => ({ body: { billId, interactive: true } })))
    }
    result.imported.push(...found)
  }
  return result
}
