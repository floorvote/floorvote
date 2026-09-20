import { sql, and, eq, isNotNull, exists, count } from 'drizzle-orm'
import { magicLinks, users } from '../db/schema'
import type { getDb } from '../db/client'

type Db = ReturnType<typeof getDb>

/**
 * "Has this user ever used a magic link?" — the shared definition of an accepted
 * invite, and the only one. Three call sites need it in three different shapes,
 * which is why this module exports three things rather than one:
 *
 *   - `hasLoggedInSelect` — a correlated subquery for a SELECT list, used by the
 *     Members admin page, which needs the flag per row alongside other columns.
 *   - `hasLoggedInWhere` — a Drizzle `exists()` for a WHERE clause, used by the
 *     sidebar stats member count.
 *   - `usedMagicLinkCount` — the count itself, used by the terms-acceptance gate
 *     to tell a first-time login from a returning member.
 *
 * They are kept together because they must never drift apart: the count and the
 * boolean disagreeing would mean a first-timer and an "accepted member" could be
 * the same person by one definition and not the other.
 *
 * Rows are deleted only on account deletion — no cron prunes them — so the count
 * is monotonic.
 */

/** For a SELECT list: 1 when the user has used a magic link, else 0. */
export const hasLoggedInSelect = sql<number>`CASE WHEN EXISTS (
        SELECT 1 FROM magic_links WHERE user_id = users.id AND used_at IS NOT NULL
      ) THEN 1 ELSE 0 END`

/** For a WHERE clause on a query over `users`. */
export function hasLoggedInWhere(db: Db) {
  return exists(
    db.select({ id: magicLinks.id })
      .from(magicLinks)
      .where(and(eq(magicLinks.userId, users.id), isNotNull(magicLinks.usedAt))),
  )
}

/**
 * How many magic links this user has used.
 *
 * The terms gate needs the number, not the boolean: the acceptance interstitial
 * renders *after* verify has marked the link used, so a genuine first-timer is
 * at exactly 1, not 0. A superadmin bootstrapped from a JWT has no magic link at
 * all and sits at 0 — never a first-timer.
 */
export async function usedMagicLinkCount(db: Db, userId: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(magicLinks)
    .where(and(eq(magicLinks.userId, userId), isNotNull(magicLinks.usedAt)))
    .get()
  return row?.n ?? 0
}
