import { desc, gte, isNotNull, isNull, sql } from 'drizzle-orm'
import { apiCallLog, bills, billCalendar, bodyEvents, cutovers, sessions, stateProviders, tenants } from '../db/schema'
import { DEFAULT_PROVIDER_ID, PROVIDERS, findProvider, type Provider } from '../providers'
import { isSnapshotProvider } from '../cron/sync-snapshots'
import { providerCapabilities } from './capabilities'
import { monthStartDb } from './legiscanBudget'
import { providerConfigured } from './providerRouting'
import { DEFAULT_FULL_HOURS_ET, DEFAULT_RAW_HOURS_ET, decideMode, getCurrentEtHour } from './sync-schedule'
import type { Db, Env } from '../types'

/**
 * The rows of central admin's States section (#402): one per state central
 * covers, assembled from state ownership, the provider registry, the session
 * schedule, the sync log, `bills.carried_from`, and `api_call_log`. Read only,
 * and nothing in a row is a secret: a key shows as set or missing.
 */

/** How much of a provider's outbound traffic `api_call_log` records. */
export type CallCoverage = 'full' | 'partial' | 'none'

/**
 * What each provider logs (`ProviderContext.logCall`). A provider that logs
 * only some of its calls, or none, shows its count as partial or not recorded,
 * never as a plain zero. Change an entry when a provider's logging changes: a
 * test holds an entry for every provider in the registry.
 */
export const CALL_LOGGING: Record<string, CallCoverage> = {
  legiscan: 'full',
  lims: 'full',
  lis: 'partial',
  mga: 'none',
  govinfo: 'none',
}

/** A state with no read in this long is flagged. */
const STALE_MS = 48 * 60 * 60 * 1000

export interface StateRow {
  state: string
  /** Active tenants covering the state, wildcards included. */
  tenantCount: number
  provider: {
    id: string
    name: string
    /** When the owner took the state: the cutover or claim date. Null for a state with no ownership row. */
    since: string | null
    sinceKind: 'default' | 'claim' | 'cutover'
    /** The state's latest cutover is still undoable (`planUndo`'s conditions). */
    undoAvailable: boolean
    /** Other providers that hold sessions in the state, such as the one it was cut over from. */
    otherProviders: string[]
  }
  configured: {
    keyStatus: 'set' | 'missing' | 'not_required'
    /** `default` for LegiScan's own queue, `own` for a bound provider queue, `shared` for a provider using LegiScan's. */
    queue: 'default' | 'own' | 'shared'
    /** Set when the owner can't run here, so the state isn't syncing. */
    warning: string | null
  }
  schedule: {
    fullHours: number[]
    /** Null for a snapshot provider, which has no raw pass. */
    rawHours: number[] | null
    /** Some active session overrides the default hours. */
    override: boolean
    lastRead: string | null
    nextRead: string | null
    /** No read in 48 hours, or none at all. */
    stale: boolean
    /** The last pass's counts, from the sync log. Null when the owner has none logged. */
    lastPass: { billsChecked: number; billsChanged: number; billsQueued: number } | null
  }
  /** Moved bills (`bills.carried_from`) still waiting for the new provider's first ingest. */
  waitingFirstIngest: number
  /** This month's calls of the owning provider, which `api_call_log` doesn't split by state. */
  calls: { provider: string; count: number; coverage: CallCoverage }
  capabilities: {
    bodyEvents: boolean
    deadlines: boolean
    calendarEvents: { bill: number; body: number }
  }
}

type SessionRow = typeof sessions.$inferSelect

/** A stored timestamp ('YYYY-MM-DD HH:MM:SS' UTC, or ISO) as ISO. */
function iso(stored: string | null | undefined): string | null {
  if (!stored) return null
  const d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(stored) ? `${stored.replace(' ', 'T')}Z` : stored)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function parseHours(json: string | null, fallback: number[]): number[] {
  if (!json) return fallback
  try {
    const arr = JSON.parse(json)
    if (Array.isArray(arr) && arr.every(n => Number.isInteger(n) && n >= 0 && n < 24)) return arr
  } catch { /* falls back to the defaults, as decideMode does */ }
  return fallback
}

function sortedUnion(lists: number[][]): number[] {
  return [...new Set(lists.flat())].sort((a, b) => a - b)
}

/** The next top of an hour, within two days, at which one of `rows` would be read. */
function nextRead(rows: SessionRow[], snapshot: boolean, now: Date): string | null {
  const first = Math.floor(now.getTime() / 3_600_000) + 1
  for (let h = first; h < first + 48; h++) {
    const at = new Date(h * 3_600_000)
    const etHour = getCurrentEtHour(at)
    if (rows.some(r => snapshot ? decideMode(r, etHour) === 'full' : decideMode(r, etHour) !== 'skip')) return at.toISOString()
  }
  return null
}

function coveredStates(coverageJson: string): string[] {
  try {
    const parsed = JSON.parse(coverageJson)
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch { return [] }
}

const bucket = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    out.set(k, [...(out.get(k) ?? []), item])
  }
  return out
}

export async function loadStateRows(db: Db, env: Env, now: Date = new Date()): Promise<StateRow[]> {
  const [activeTenants, ownership, allSessions, allCutovers] = await Promise.all([
    db.select({ coverage: tenants.stateCoverage }).from(tenants).where(sql`${tenants.active} = 1`).all(),
    db.select().from(stateProviders).all(),
    db.select().from(sessions).all(),
    db.select().from(cutovers).where(isNull(cutovers.undoneAt)).orderBy(desc(cutovers.createdAt), desc(sql`rowid`)).all(),
  ])

  let wildcardTenants = 0
  const tenantsByState = new Map<string, number>()
  for (const t of activeTenants) {
    const covered = coveredStates(t.coverage)
    if (covered.includes('*')) wildcardTenants++
    for (const state of new Set(covered)) if (state !== '*') tenantsByState.set(state, (tenantsByState.get(state) ?? 0) + 1)
  }
  const states = [...new Set([...tenantsByState.keys(), ...ownership.map(o => o.state), ...allSessions.map(s => s.state)])].sort()
  if (states.length === 0) return []

  const ownerRows = new Map(ownership.map(o => [o.state, o]))
  const sessionsByState = bucket(allSessions, s => s.state)
  // The latest cutover not undone, per state: what planUndo undoes.
  const latestCutover = new Map<string, typeof allCutovers[number]>()
  for (const c of allCutovers) if (!latestCutover.has(c.state)) latestCutover.set(c.state, c)

  const waiting = new Map((await db.select({ state: bills.state, n: sql<number>`COUNT(*)` }).from(bills)
    .where(isNotNull(bills.carriedFrom)).groupBy(bills.state).all()).map(r => [r.state, Number(r.n)]))
  const billEvents = new Map((await db.select({ state: bills.state, n: sql<number>`COUNT(*)` }).from(billCalendar)
    .innerJoin(bills, sql`${bills.billId} = ${billCalendar.billId}`).where(isNull(billCalendar.cancelledAt))
    .groupBy(bills.state).all()).map(r => [r.state, Number(r.n)]))
  const bodyCounts = new Map((await db.select({ state: bodyEvents.state, n: sql<number>`COUNT(*)` }).from(bodyEvents)
    .where(isNull(bodyEvents.cancelledAt)).groupBy(bodyEvents.state).all()).map(r => [r.state, Number(r.n)]))

  // This month's calls by provider, from the call type's prefix: 'lims:Members' is LIMS's, and a type with no colon is LegiScan's.
  const callsByProvider = new Map<string, number>()
  for (const r of await db.select({ callType: apiCallLog.callType, n: sql<number>`COUNT(*)` }).from(apiCallLog)
    .where(gte(apiCallLog.loggedAt, monthStartDb(now))).groupBy(apiCallLog.callType).all()) {
    const colon = r.callType.indexOf(':')
    const id = colon === -1 ? DEFAULT_PROVIDER_ID : r.callType.slice(0, colon)
    callsByProvider.set(id, (callsByProvider.get(id) ?? 0) + Number(r.n))
  }

  // Each state's latest logged pass among its owner's sessions. Each owned session's newest
  // pass is one lookup in idx_session_sync_log_session_synced, so this reads a row per session
  // rather than the whole log; the newest of those per state is picked here.
  const passes = new Map<string, { id: number; state: string; synced_at: string; bills_checked: number; bills_changed: number; bills_queued: number }>()
  for (const r of await db.all<{ id: number; state: string; synced_at: string; bills_checked: number; bills_changed: number; bills_queued: number }>(sql`
    SELECT l.id, l.state, l.synced_at, l.bills_checked, l.bills_changed, l.bills_queued
    FROM sessions s
    JOIN session_sync_log l ON l.id = (
      SELECT l2.id FROM session_sync_log l2 WHERE l2.session_id = s.session_id
      ORDER BY l2.synced_at DESC, l2.id DESC LIMIT 1)
    WHERE s.provider = COALESCE((SELECT provider FROM state_providers WHERE state = s.state), ${DEFAULT_PROVIDER_ID})`)) {
    const best = passes.get(r.state)
    if (!best || r.synced_at > best.synced_at || (r.synced_at === best.synced_at && r.id > best.id)) passes.set(r.state, r)
  }

  return states.map((state): StateRow => {
    const row = ownerRows.get(state)
    const ownerId = row?.provider ?? DEFAULT_PROVIDER_ID
    const provider: Provider | undefined = findProvider(ownerId)
    const stateSessions = sessionsByState.get(state) ?? []
    const owned = stateSessions.filter(s => s.provider === ownerId)
    const active = owned.filter(s => s.sineDie !== 1 && s.syncEnabled)
    const snapshot = isSnapshotProvider(provider)

    // Provider and since.
    const cutover = latestCutover.get(state)
    const cutoverApplies = !!cutover && cutover.toProvider === ownerId
    const from = cutover ? findProvider(cutover.fromProvider) : undefined
    const undoAvailable = cutoverApplies && !!from && !!provider && providerConfigured(from, env)
    const sinceKind = cutoverApplies ? 'cutover' : row ? 'claim' : 'default'
    const since = iso(cutoverApplies ? cutover!.createdAt : row?.claimedAt)

    // Configured.
    const configured = provider ? providerConfigured(provider, env) : false
    const queue = ownerId === DEFAULT_PROVIDER_ID ? 'default'
      : provider?.ingestQueue && env[provider.ingestQueue] ? 'own' : 'shared'
    const name = provider?.displayName ?? ownerId
    const warning = !provider ? `${ownerId} owns this state but isn't a provider this central knows, so the state isn't syncing`
      : !configured ? `${name} owns this state but isn't configured, so the state isn't syncing`
      : null

    // Schedule.
    const lastReads = [...owned.map(s => iso(s.lastSyncedAt)), iso(passes.get(state)?.synced_at)].filter((d): d is string => !!d).sort()
    const lastRead = lastReads.at(-1) ?? null
    const pass = passes.get(state)
    const hoursOf = (pick: (s: SessionRow) => string | null, fallback: number[]) =>
      active.length === 0 ? fallback : sortedUnion(active.map(s => parseHours(pick(s), fallback)))

    return {
      state,
      tenantCount: (tenantsByState.get(state) ?? 0) + wildcardTenants,
      provider: {
        id: ownerId, name, since, sinceKind, undoAvailable,
        otherProviders: [...new Set(stateSessions.map(s => s.provider).filter(p => p !== ownerId))].sort(),
      },
      configured: {
        keyStatus: provider?.configured ? (configured ? 'set' : 'missing') : 'not_required',
        queue, warning,
      },
      schedule: {
        fullHours: hoursOf(s => s.fullSyncHoursEt, DEFAULT_FULL_HOURS_ET),
        rawHours: snapshot ? null : hoursOf(s => s.rawSyncHoursEt, DEFAULT_RAW_HOURS_ET),
        override: active.some(s => s.fullSyncHoursEt !== null || s.rawSyncHoursEt !== null),
        lastRead,
        nextRead: nextRead(active, snapshot, now),
        stale: !lastRead || now.getTime() - new Date(lastRead).getTime() > STALE_MS,
        lastPass: pass ? { billsChecked: pass.bills_checked, billsChanged: pass.bills_changed, billsQueued: pass.bills_queued } : null,
      },
      waitingFirstIngest: waiting.get(state) ?? 0,
      calls: { provider: ownerId, count: callsByProvider.get(ownerId) ?? 0, coverage: CALL_LOGGING[ownerId] ?? 'none' },
      capabilities: {
        ...(provider ? { bodyEvents: providerCapabilities(provider).bodyEvents, deadlines: providerCapabilities(provider).deadlines } : { bodyEvents: false, deadlines: false }),
        calendarEvents: { bill: billEvents.get(state) ?? 0, body: bodyCounts.get(state) ?? 0 },
      },
    }
  })
}
