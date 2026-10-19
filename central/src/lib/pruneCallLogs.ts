import { sql } from 'drizzle-orm'
import type { Db } from '../types'

/**
 * How long `api_call_log` and `session_sync_log` rows are kept.
 *
 * The longest window anything reads is the Budget page's 90-day call series
 * (`/budget`'s `monthDaily`, which starts 89 days back at midnight UTC); the
 * monthly LegiScan limit reads the current month, and the Sync page reads the
 * newest ticks. Four months leaves a month of margin over the 90-day series, so
 * no chart loses a day it draws. A state that has logged no pass for longer than
 * this shows no last pass on the States page, and is already flagged stale there.
 */
export const CALL_LOG_RETENTION_DAYS = 120

/** About how many rows to delete per statement, so one query stays well inside D1's per-query limits. */
const BATCH_SIZE = 5000
/** Statements per table per run: 100,000 rows, then the rest waits for tomorrow's run, which is far more than a day adds. */
const MAX_BATCHES = 20

export type PruneResult = { apiCallLog: number; sessionSyncLog: number }
export type PruneOptions = { batchSize?: number; maxBatches?: number }

/** The stored format of logged_at / synced_at: 'YYYY-MM-DD HH:MM:SS' in UTC. */
const dbFormat = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')

/**
 * Delete log rows older than the retention age, oldest first, in bounded
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
  const cutoff = dbFormat(new Date(now.getTime() - CALL_LOG_RETENTION_DAYS * 86_400_000))
  const batchSize = opts.batchSize ?? BATCH_SIZE
  const maxBatches = opts.maxBatches ?? MAX_BATCHES

  async function prune(table: 'api_call_log' | 'session_sync_log', column: 'logged_at' | 'synced_at'): Promise<number> {
    const t = sql.raw(table)
    const c = sql.raw(column)
    let deleted = 0
    for (let i = 0; i < maxBatches; i++) {
      const res = await db.run(sql`DELETE FROM ${t} WHERE ${c} < ${cutoff}
        AND ${c} <= (SELECT MAX(${c}) FROM (SELECT ${c} FROM ${t} WHERE ${c} < ${cutoff} ORDER BY ${c} LIMIT ${batchSize}))`)
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
