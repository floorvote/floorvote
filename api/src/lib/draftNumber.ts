import { and, eq, like } from 'drizzle-orm'
import { bills } from '../db/schema'
import type { getDb } from '../db/client'

/** Draft numbers are D1, D2, … per state — GitHub-PR style, not a real bill
 *  number. The D prefix is what keeps them from ever colliding with a filed
 *  bill's number, which would make /bills/resolve ambiguous. */
export async function nextDraftNumber(
  db: ReturnType<typeof getDb>,
  state: string,
): Promise<string> {
  const rows = await db
    .select({ billNumber: bills.billNumber })
    .from(bills)
    .where(and(eq(bills.isDraft, true), eq(bills.state, state), like(bills.billNumber, 'D%')))
    .all()
  let max = 0
  for (const r of rows) {
    const m = /^D(\d+)$/.exec(r.billNumber)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `D${max + 1}`
}
