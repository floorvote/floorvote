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

/** A draft's number must be unique among ALL bills in the same state and year,
 *  not just among drafts: /bills/resolve/:state/:sessionSlug/:billNumber has no
 *  way to choose between two bills that answer to the same triple. Returns the
 *  colliding bill's id, or null. */
export async function findNumberCollision(
  db: ReturnType<typeof getDb>,
  opts: { state: string; year: number; billNumber: string; excludeId?: string },
): Promise<string | null> {
  const rows = await db
    .select({ id: bills.id })
    .from(bills)
    .where(and(
      eq(bills.state, opts.state),
      eq(bills.billNumber, opts.billNumber),
      eq(bills.yearStart, opts.year),
    ))
    .all()
  const hit = rows.find(r => r.id !== opts.excludeId)
  return hit?.id ?? null
}
