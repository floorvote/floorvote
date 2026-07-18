import { and, eq, isNull, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import type { getDb } from '../db/client'

// "Active" owner = role='owner' AND deactivatedAt IS NULL. A deactivated owner must not count.
export async function countActiveOwners(db: ReturnType<typeof getDb>): Promise<number> {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, 'owner'), isNull(users.deactivatedAt)))
    .get()
  return row?.count ?? 0
}
