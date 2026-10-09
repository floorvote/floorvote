import type { LegiscanBill } from '../lib/legiscan'
import type { LsEnv, LsDb } from '../types-legiscan'

/**
 * A legislature's own feed, read directly instead of through LegiScan. See
 * docs/internal/direct-sources.md.
 *
 * A source writes into the same tables as LegiScan, in LegiScan's shapes, so
 * everything downstream (the ingestor, tenants, AI) is shared. What it adds is
 * its own sync and the knowledge of how to build one bill.
 */
export interface DirectSource {
  /** Stored in the `source` column of the bills, sessions and people it writes. */
  id: string
  /** States this source covers when enabled; the LegiScan sync leaves them alone. */
  states: readonly string[]
  /** Whether this deployment is configured to read the source (keys, flags). */
  enabled(env: LsEnv): boolean
  /** The full record for one bill, in LegiScan's `getBill` shape. */
  buildBill(billId: number, env: LsEnv, db: LsDb): Promise<LegiscanBill>
  /** Labels for the status codes this source writes to `bills.status`. */
  statusLabels: Readonly<Record<number, string>>
}
