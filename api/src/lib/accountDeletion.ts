import { eq, isNull } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { associationConfig, users } from '../db/schema'

export const ACCOUNT_DELETION_KEY = 'account_deletion_enabled'

/** Owner-gated master switch for hard account deletion. Absent key = disabled. */
export async function getAccountDeletionEnabled(db: ReturnType<typeof getDb>): Promise<boolean> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, ACCOUNT_DELETION_KEY)).get()
  if (!row) return false
  try { return JSON.parse(row.value) === true } catch { return row.value === 'true' }
}

/**
 * A member's activity is hidden from member-facing app surfaces while they are
 * deactivated. Add to `and(...)` at any read that joins `users` and surfaces
 * their votes/comments/reactions/feed events. Single source of truth — do not
 * inline `isNull(users.deactivatedAt)` elsewhere.
 */
export const activeUser = isNull(users.deactivatedAt)
