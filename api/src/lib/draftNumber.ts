import { and, eq, like } from 'drizzle-orm'
import { bills } from '../db/schema'
import type { getDb } from '../db/client'
import { billSlug } from './sessionSlug'

/** Draft numbers are D1, D2, … per state — GitHub-PR style, not a real bill
 *  number. The D prefix is what keeps them from ever colliding with a filed
 *  bill's number, which would make /bills/resolve ambiguous — except that
 *  a filed bill CAN incidentally be numbered like a draft (e.g. a real
 *  'D3'), so this scans every bill in the state, not just drafts, when
 *  picking the next number. Otherwise an auto-assigned number could still
 *  collide with a filed bill the caller never chose and can't correct. */
export async function nextDraftNumber(
  db: ReturnType<typeof getDb>,
  state: string,
): Promise<string> {
  const rows = await db
    .select({ billNumber: bills.billNumber })
    .from(bills)
    .where(and(eq(bills.state, state), like(bills.billNumber, 'D%')))
    .all()
  let max = 0
  for (const r of rows) {
    const m = /^D(\d+)$/.exec(r.billNumber)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `D${max + 1}`
}

/** A draft's number must be unique among ALL bills in the same state that
 *  answer to the same URL slug, not just among drafts:
 *  /bills/resolve/:state/:sessionSlug/:billNumber has no way to choose between
 *  two bills that answer to the same triple. Returns the colliding bill's id,
 *  or null.
 *
 *  Two bills collide when they share a state and number AND either
 *  (a) they share a year_start, or (b) the candidate's effective slug is the
 *  draft's year. (b) is what the resolve routes actually compare, and it is
 *  not implied by (a): a filed biennium row with year_start 2025 and session
 *  '2026 Regular Session' answers to /UT/2026/HB0209 while its year_start says
 *  2025. (a) is kept as well so a filed row with no session string — which
 *  slugs to '' and so matches nothing — still blocks a same-year number.
 *
 *  This is a best-effort, read-then-write check — no database constraint
 *  enforces the triple's uniqueness, so two concurrent creates could both
 *  pass this check and both write. Acceptable here because this is an
 *  admin-only route and a given tenant's draft numbering is effectively
 *  single-writer; the failure mode of a lost race is a duplicate number,
 *  not data loss. */
export async function findNumberCollision(
  db: ReturnType<typeof getDb>,
  opts: { state: string; year: number; billNumber: string; excludeId?: string },
): Promise<string | null> {
  const rows = await db
    .select({
      id: bills.id,
      session: bills.session,
      isDraft: bills.isDraft,
      yearStart: bills.yearStart,
    })
    .from(bills)
    .where(and(
      eq(bills.state, opts.state),
      eq(bills.billNumber, opts.billNumber),
    ))
    .all()
  const slug = String(opts.year)
  const hit = rows.find(r =>
    r.id !== opts.excludeId && (r.yearStart === opts.year || billSlug(r) === slug))
  return hit?.id ?? null
}
