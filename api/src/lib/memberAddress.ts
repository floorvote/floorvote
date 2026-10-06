import { inArray, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import type { AppDb } from '../types'
import { isValidEmail } from '../../../shared/email'

// The one place the server normalizes and checks an address it is about to
// give a member, whether inviting them or changing their address. Callers own
// what a result means for them: bulk invite also flags repeats within its own
// batch, and a caller changing one member's address can tell "unchanged" from
// "taken" by comparing `userId` with that member's id.

export type MemberAddressCheck =
  /** Lowercased and trimmed, but not a deliverable address. Never rewritten further. */
  | { email: string; status: 'invalid' }
  /** Already a member's address, compared without regard to case. Deactivated members count. */
  | { email: string; status: 'taken'; userId: string }
  | { email: string; status: 'available' }

// D1 caps a query at 100 bound parameters.
const LOOKUP_CHUNK = 90

/** Lowercase and trim. Punctuation is not stripped: a malformed address is rejected, not repaired. */
export function normalizeMemberAddress(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().trim()
}

/**
 * Check each raw address against the shared validity rule and every existing
 * member, deactivated included. Returns one result per input, in input order,
 * looking up all valid addresses in as few queries as D1 allows.
 */
export async function checkMemberAddresses(
  db: AppDb,
  rawEmails: readonly (string | null | undefined)[],
): Promise<MemberAddressCheck[]> {
  const emails = rawEmails.map(normalizeMemberAddress)
  const candidates = [...new Set(emails.filter(isValidEmail))]

  // Compared on lower(email), not the stored value: the superadmin sign-in
  // path stores an address as the identity provider sent it, mixed case and
  // all. Not index-backed, but the members table is small.
  const storedLower = sql<string>`lower(${users.email})`
  const takenBy = new Map<string, string>()
  for (let i = 0; i < candidates.length; i += LOOKUP_CHUNK) {
    const rows = await db
      .select({ id: users.id, email: storedLower })
      .from(users)
      .where(inArray(storedLower, candidates.slice(i, i + LOOKUP_CHUNK)))
      .all()
    for (const r of rows) if (!takenBy.has(r.email)) takenBy.set(r.email, r.id)
  }

  return emails.map((email): MemberAddressCheck => {
    if (!isValidEmail(email)) return { email, status: 'invalid' }
    const userId = takenBy.get(email)
    return userId ? { email, status: 'taken', userId } : { email, status: 'available' }
  })
}
