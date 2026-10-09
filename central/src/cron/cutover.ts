import { and, eq, sql } from 'drizzle-orm'
import { billTenants, tenants } from '../db/schema-legiscan'
import { getCurrentEtHour } from '../lib/sync-schedule'
import { nowDb } from '../lib/dbTime'
import { resolveTenantRpc } from '../lib/tenantRpc'
import { legacyLinks, runSourceSync, storeRecords, type SourcePassReport } from './sync-sources'
import type { DirectSource, SyncContext } from '../sources/types'
import type { LsEnv, LsDb } from '../types-legiscan'

/**
 * Moving a state that tenants already follow from LegiScan to a direct source
 * (docs/internal/direct-sources.md). The source's sync refuses to run while
 * tenants link that state's LegiScan bills, because it would give each bill a
 * second copy under a new id. This moves the links instead:
 *
 * 1. Plan: refresh the source's sessions, store their records (nothing a tenant
 *    sees), and match each linked LegiScan bill in an overlapping session to
 *    the source's bill with the same year, kind of session and number.
 * 2. Apply: each tenant points its bills at the new ids (its rows, positions,
 *    notes and analyses stay), central moves the links, monitor-only links with
 *    no match are dropped, and the source's sync runs. Its pass creates the new
 *    bills and queues every tracked one for ingest, so tenants refetch them.
 *
 * A tenant's AI runs again on a moved bill when the new source's text differs.
 */

export interface CutoverLink {
  tenantId: string
  matchType: string | null
  number: string
  session: string
  from: number
  /** The source's bill for it, or null when none matched. */
  to: number | null
}

export interface CutoverPlan {
  source: string
  states: string[]
  sessions: string[]
  links: CutoverLink[]
}

export interface CutoverTenantReport {
  moved: number
  /** Bills the tenant re-pointed at new ids. */
  rekeyed: number
  /** Links with no match that were dropped (monitor-only, or all with dropUnmatched). */
  dropped: number
  /** Tracked links with no match, left in place: the source's sync stays paused while any remain. */
  kept: CutoverLink[]
  error?: string
}

export interface CutoverReport {
  plan: { matched: number; unmatched: number }
  tenants: Record<string, CutoverTenantReport>
  /** The source's sync, when nothing was left blocking it. */
  synced?: SourcePassReport[]
  blocked?: string
}

/** "HB0001" → "HB1", "B26-0400" → "B26-400": numbers compared without padding or spaces. */
export function comparableNumber(n: string): string {
  return n.toUpperCase().replace(/\s+/g, '').replace(/(^|\D)0+(?=\d)/g, '$1')
}

export async function planCutover(source: DirectSource, env: LsEnv, db: LsDb): Promise<CutoverPlan> {
  const ctx: SyncContext = { today: nowDb().slice(0, 10), etHour: getCurrentEtHour(), force: true }
  const sessions = await source.syncSessions(env, db, ctx)

  // The source's bills by year, kind of session and number. A key two bills
  // share (two special sessions in one year) matches neither.
  const byKey = new Map<string, number | null>()
  for (const session of sessions) {
    const records = await source.snapshot(session, env, db, ctx)
    const entries = await storeRecords(source, session, records, db, ctx)
    for (const e of entries) {
      const key = `${session.yearStart}|${session.special}|${comparableNumber(e.number)}`
      byKey.set(key, byKey.has(key) ? null : e.bill_id)
    }
  }

  const legacy = await legacyLinks(db, [...source.states], sessions)
  return {
    source: source.id,
    states: [...source.states],
    sessions: sessions.map(s => s.sessionName),
    links: legacy.map(l => ({
      tenantId: l.tenantId,
      matchType: l.matchType,
      number: l.number,
      session: l.sessionName,
      from: l.billId,
      to: byKey.get(`${l.yearStart}|${l.special}|${comparableNumber(l.number)}`) ?? null,
    })),
  }
}

export async function applyCutover(
  source: DirectSource, plan: CutoverPlan, env: LsEnv, db: LsDb, opts: { dropUnmatched?: boolean } = {},
): Promise<CutoverReport> {
  const report: CutoverReport = {
    plan: { matched: plan.links.filter(l => l.to).length, unmatched: plan.links.filter(l => !l.to).length },
    tenants: {},
  }
  const byTenant = new Map<string, CutoverLink[]>()
  for (const l of plan.links) byTenant.set(l.tenantId, [...(byTenant.get(l.tenantId) ?? []), l])

  for (const [tenantId, links] of byTenant) {
    const r: CutoverTenantReport = { moved: 0, rekeyed: 0, dropped: 0, kept: [] }
    report.tenants[tenantId] = r
    const matched = links.filter((l): l is CutoverLink & { to: number } => l.to !== null)

    // The tenant first, so it never receives a new id it does not hold yet.
    if (matched.length > 0) {
      const rpc = resolveTenantRpc(env, tenantId)
      const active = await db.select({ active: tenants.active }).from(tenants).where(eq(tenants.tenantId, tenantId)).get()
      if (!rpc && active?.active) { r.error = `tenant ${tenantId} has no service binding (TENANT_${tenantId.toUpperCase().replaceAll('-', '_')}); its links were left in place`; continue }
      if (rpc) {
        try {
          r.rekeyed = (await rpc.rekeyBills(matched.map(l => ({ from: `legiscan:${l.from}`, to: `legiscan:${l.to}` })))).rekeyed
        } catch (err) {
          r.error = `tenant ${tenantId} could not re-point its bills: ${err instanceof Error ? err.message : String(err)}`
          continue
        }
      }
    }

    const stmts = []
    for (const l of matched) {
      stmts.push(db.insert(billTenants).values({ billId: l.to, tenantId, matchType: l.matchType })
        .onConflictDoUpdate({
          target: [billTenants.billId, billTenants.tenantId],
          set: { matchType: sql`coalesce(excluded.match_type, ${billTenants.matchType})` },
        }))
      stmts.push(db.delete(billTenants).where(and(eq(billTenants.billId, l.from), eq(billTenants.tenantId, tenantId))))
      r.moved++
    }
    for (const l of links.filter(l => l.to === null)) {
      if (l.matchType === null || opts.dropUnmatched) {
        stmts.push(db.delete(billTenants).where(and(eq(billTenants.billId, l.from), eq(billTenants.tenantId, tenantId))))
        r.dropped++
      } else r.kept.push(l)
    }
    for (let i = 0; i < stmts.length; i += 100) {
      const chunk = stmts.slice(i, i + 100)
      await db.batch(chunk as [typeof chunk[0], ...typeof chunk])
    }
  }

  const remaining = Object.values(report.tenants).reduce((n, t) => n + t.kept.length, 0)
  const failed = Object.entries(report.tenants).filter(([, t]) => t.error).map(([id]) => id)
  if (failed.length > 0 || remaining > 0) {
    report.blocked = [
      failed.length > 0 ? `tenants not moved: ${failed.join(', ')}` : '',
      remaining > 0 ? `${remaining} tracked links have no match in ${source.id} (pass dropUnmatched=true to drop them)` : '',
    ].filter(Boolean).join('; ')
    return report
  }
  report.synced = await runSourceSync(source, env, db, { force: true })
  return report
}
