import { sql } from 'drizzle-orm'
import { users } from '../db/schema'

// The name to show for a person. A user's name is optional and can be cleared
// (stored as an empty string); wherever a name would appear, a blank one falls
// back to the email. Mirrors displayName() in web/src/lib/chipStyles.ts.
export function displayName(user: { name?: string | null; email?: string | null }): string {
  return user.name || user.email || ''
}

// The same fallback as a select column, for queries that only need the label.
// NULL when the join found no user (e.g. events by the synthetic 'system' author).
export const userDisplayNameSql = sql<string | null>`coalesce(nullif(${users.name}, ''), ${users.email})`
