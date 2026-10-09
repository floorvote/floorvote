import type { LegiscanBill, MasterListEntry } from '../lib/legiscan'
import type { sessions } from '../db/schema-legiscan'
import type { LsEnv, LsDb } from '../types-legiscan'

/**
 * A legislature's own feed, read directly instead of through LegiScan. See
 * docs/internal/direct-sources.md.
 *
 * A source writes into the same tables as LegiScan, in LegiScan's shapes, so
 * everything downstream (the ingestor, tenants, AI) is shared. What it adds is
 * how to list a session's bills and how to build one bill; the sync around
 * that (cron/sync-sources.ts) is common to every source.
 */
export interface DirectSource {
  /** Stored in the `source` column of the bills, sessions and people it writes. */
  id: string
  /** States this source covers when enabled; the LegiScan sync leaves them alone. */
  states: readonly string[]
  /** Whether this deployment is configured to read the source (keys, flags). */
  enabled(env: LsEnv): boolean
  /** Ingestor queue for this source's bills, when it needs its own (rate limits). */
  ingestQueue?(env: LsEnv): Queue | undefined

  /**
   * The sessions to sync, after refreshing session (and member) data when it is
   * due. Rows of the `sessions` table, written with this source's id.
   */
  syncSessions(env: LsEnv, db: LsDb, ctx: SyncContext): Promise<SessionRow[]>
  /** Every record the source lists for one session: its current snapshot. */
  snapshot(session: SessionRow, env: LsEnv, db: LsDb, ctx: SyncContext): Promise<SourceRecord[]>
  /** The masterlist entry for one record, for keyword matching and change gating. */
  toEntry(record: SourceRecord, stored: { description: string | null }, ctx: SyncContext): Promise<MasterListEntry>
  /** The full record for one bill, in LegiScan's `getBill` shape. */
  buildBill(billId: number, env: LsEnv, db: LsDb): Promise<LegiscanBill>

  /**
   * For sources whose per-bill details can change while the listed record does
   * not (LIMS LegislationDetails): tracked bills not in a settled status are
   * re-queued when their details are older than `maxAge`, `perPass` at most.
   */
  detailsRefresh?: { maxAge: string; perPass: number; settledStatuses: number[] }

  /** Labels for the status codes this source writes to `bills.status`. */
  statusLabels: Readonly<Record<number, string>>
}

export type SessionRow = typeof sessions.$inferSelect

export interface SyncContext {
  /** YYYY-MM-DD, UTC. */
  today: string
  etHour: number
  /** The admin "run now" route: refresh everything and ignore the hour of day. */
  force: boolean
}

/** One listed record: the source's own key and data, the central bill id, and the change signal. */
export interface SourceRecord {
  billId: number
  nativeKey: string
  raw: unknown
  hash: string
}
