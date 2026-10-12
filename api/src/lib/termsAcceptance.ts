import { sql, eq } from 'drizzle-orm'
import { termsAcceptances } from '../db/schema'
import { usedMagicLinkCount } from './loginHistory'
import type { getDb } from '../db/client'
import { isSuperadminEmailViaCentral } from './superadminCentral'
import type { Env } from '../types'

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
  env: Env,
  userId: string,
  email: string,
  // True on the dashboard-JWT branch, where a verified token already proves the
  // person is a superadmin right now.
  knownSuperadmin = false,
): Promise<TermsAcceptanceState> {
  const termsUpdated = env.LEGAL_TERMS_UPDATED
  const row = await db
    .select({ newest: sql<string | null>`MAX(${termsAcceptances.termsUpdated})` })
    .from(termsAcceptances)
    .where(eq(termsAcceptances.userId, userId))
    .get()
  const newest = row?.newest ?? null

  // Lexicographic on YYYY-MM-DD, matching the gate in requireAuth.
  const unaccepted = !!termsUpdated && (!newest || newest < termsUpdated)
  const required = unaccepted && !knownSuperadmin && !(await isTermsExempt(env, email))

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

/**
 * Operator staff are the provider under an instance's Terms, not users bound by
 * them, so anyone currently on central's superadmin list skips the gate. Follows
 * the live list (the in-isolate hash cache the emailed-link sign-in also uses,
 * so no central round trip per request), never a stored flag: removal from the
 * list ends the exemption.
 */
export function isTermsExempt(env: Env, email: string): Promise<boolean> {
  return isSuperadminEmailViaCentral(env, email)
}
