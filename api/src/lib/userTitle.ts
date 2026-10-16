import { sql } from 'drizzle-orm'
import { users } from '../db/schema'

// A member's title is stored in `users.title`, and also in `users.subtitle` until
// the drop migration (follow-up issue). The previous build reads and writes only
// `subtitle`, so a row it wrote after migration 0105 has `subtitle` set and
// `title` null. Read `title`, falling back to `subtitle`. When both are set,
// `title` wins: this build always writes both, so they differ only when the old
// build edited an existing title, and there is no telling which is newer.

/** The title in a select: `title`, else `subtitle`. */
export const userTitleSql = sql<string | null>`coalesce(${users.title}, ${users.subtitle})`

/** The title of a whole `users` row. */
export function titleOf(user: { title: string | null; subtitle: string | null }): string | null {
  return user.title ?? user.subtitle
}
