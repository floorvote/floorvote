import { sql, eq } from 'drizzle-orm'
import { termsAcceptances } from '../db/schema'
import { usedMagicLinkCount } from './loginHistory'
import type { getDb } from '../db/client'

type Db = ReturnType<typeof getDb>

/** Drives the interstitial's copy. See the spec's "Distinguishing the three cases". */
export type TermsAcceptanceKind = 'first_login' | 'existing_member' | 'update'

export type TermsAcceptanceState = {
  termsAcceptanceRequired: boolean
  termsAcceptanceKind: TermsAcceptanceKind
}

/**
 * What /auth/me tells the client about acceptance.
 *
 * Shared by both branches of the handler on purpose. The superadmin JWT
 * bootstrap is the branch a verify-time design would have missed entirely, and
 * one helper is the cheapest way to keep it from being the branch this is
 * implemented incompletely on.
 */
export async function termsAcceptanceState(
  db: Db,
  termsUpdated: string | undefined,
  userId: string,
): Promise<TermsAcceptanceState> {
  const row = await db
    .select({ newest: sql<string | null>`MAX(${termsAcceptances.termsUpdated})` })
    .from(termsAcceptances)
    .where(eq(termsAcceptances.userId, userId))
    .get()
  const newest = row?.newest ?? null

  // Lexicographic on YYYY-MM-DD, matching the gate in requireAuth.
  const required = !!termsUpdated && (!newest || newest < termsUpdated)

  // A prior row means they have been through this before, whatever the count of
  // logins says -- so the copy is the "we've updated these" one.
  if (newest) return { termsAcceptanceRequired: required, termsAcceptanceKind: 'update' }

  // No row. Exactly one used magic link is a genuine first-timer: the
  // interstitial renders after verify has marked that link used. Zero means no
  // magic link was ever involved (a superadmin bootstrapped from a JWT), which
  // is emphatically not a first-timer -- hence a count, not a NOT EXISTS.
  const logins = await usedMagicLinkCount(db, userId)
  return {
    termsAcceptanceRequired: required,
    termsAcceptanceKind: logins === 1 ? 'first_login' : 'existing_member',
  }
}
