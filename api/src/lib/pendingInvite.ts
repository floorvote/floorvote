import { and, isNotNull, isNull, not } from 'drizzle-orm'
import { users } from '../db/schema'
import { hasLoggedInWhere } from './loginHistory'
import type { AppDb } from '../types'

// The one server-side definition of a pending invite (CONTEXT.md): a member
// someone invited, who has never signed in and is not deactivated. A member
// with no inviter joined another way, so is never a pending invite. Two
// shapes, kept together so they can't drift: a WHERE clause for queries over
// `users`, and a test for a member row already in hand.

/** For a WHERE clause on a query over `users`. */
export function pendingInviteWhere(db: AppDb) {
  return and(isNotNull(users.invitedBy), isNull(users.deactivatedAt), not(hasLoggedInWhere(db)))!
}

/** For a fetched member row; `hasLoggedIn` as `hasLoggedInSelect` returns it. */
export function isPendingInvite(m: { invitedBy: string | null; deactivatedAt: string | null; hasLoggedIn: number | boolean }): boolean {
  return m.invitedBy !== null && !m.deactivatedAt && !m.hasLoggedIn
}
