import { sql } from 'drizzle-orm'
import type { Db } from '../types'
import { toDb } from './dbTime'

/**
 * How long `api_call_log` and `session_sync_log` rows are kept.
 *
 * The longest window anything reads is the Budget page's 90-day call series
 * (`/budget`'s `monthDaily`, which starts 89 days back at midnight UTC); the
 * monthly LegiScan limit reads the current month, and the Sync page reads the
 * newest ticks. Four months leaves a month of margin over the 90-day series, so
 * no chart loses a day it draws. The prune always keeps each session's newest
 * pass, however old, so a state that stopped syncing keeps its last pass.
 */
export const CALL_LOG_RETENTION_DAYS = 120

/** About how many rows to delete per statement, so one query stays well inside D1's per-query limits. */
const BATCH_SIZE = 5000
/** Statements per table per run: 100,000 rows, then the rest waits for tomorrow's run, which is far more than a day adds. */
const MAX_BATCHES = 20

export type PruneResult = { apiCallLog: number; sessionSyncLog: number }
export type PruneOptions = { batchSize?: number; maxBatches?: number }

/**
 * Delete log rows older than the retention age (except each session's newest
 * sync pass), oldest first, in bounded
 * batches. A batch ends at the timestamp of its batchSize-th oldest row and
 * takes every row up to it, so rows sharing that second go together and a batch
 * can run a little over. (`DELETE ... WHERE id IN (SELECT ... LIMIT n)` is the
 * usual bound, but SQLite plans it as a scan of the whole table when the table
 * is small next to n, and the range on the indexed column is what keeps the
 * delete off the table.) Older rows were stored as ISO timestamps ('...T...Z'), which sort
 * after a space-format timestamp of the same day, so one of those is kept up to
 * a day longer, never deleted early.
 */
export async function pruneCallLogs(db: Db, now: Date = new Date(), opts: PruneOptions = {}): Promise<PruneResult> {
  const cutoff = toDb(new Date(now.getTime() - CALL_LOG_RETENTION_DAYS * 86_400_000))
  const batchSize = opts.batchSize ?? BATCH_SIZE
  const maxBatches = opts.maxBatches ?? MAX_BATCHES

  // The rows a pass may delete from `alias`: past the cutoff, and for the sync log also not its
  // session's newest pass, so a session that stopped syncing long ago keeps the last pass the
  // States and Sync pages show for its state. "Newer" is by synced_at, then id, as those pages
  // order. The lookup is by idx_session_sync_log_session_synced, one search per candidate row.
  const eligible = (table: string, alias: string, column: string) => {
    const a = sql.raw(alias)
    const past = sql`${a}.${sql.raw(column)} < ${cutoff}`
    if (table !== 'session_sync_log') return past
    return sql`${past} AND EXISTS (SELECT 1 FROM session_sync_log n WHERE n.session_id = ${a}.session_id
      AND (n.synced_at > ${a}.synced_at OR (n.synced_at = ${a}.synced_at AND n.id > ${a}.id)))`
  }

  async function prune(table: 'api_call_log' | 'session_sync_log', column: 'logged_at' | 'synced_at'): Promise<number> {
    const t = sql.raw(table)
    const c = sql.raw(column)
    let deleted = 0
    for (let i = 0; i < maxBatches; i++) {
      // The batch's bound is taken over the same eligible rows, so a run of kept rows can't fill it.
      const res = await db.run(sql`DELETE FROM ${t} WHERE ${eligible(table, table, column)}
        AND ${c} <= (SELECT MAX(${c}) FROM (SELECT r.${c} AS ${c} FROM ${t} r WHERE ${eligible(table, 'r', column)} ORDER BY r.${c} LIMIT ${batchSize}))`)
      const n = res.meta.changes ?? 0
      deleted += n
      if (n < batchSize) break
    }
    return deleted
  }

  return {
    apiCallLog: await prune('api_call_log', 'logged_at'),
    sessionSyncLog: await prune('session_sync_log', 'synced_at'),
  }
}
