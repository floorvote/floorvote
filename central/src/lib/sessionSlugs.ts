import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { sessions } from '../db/schema'
import { sessionToSlug } from '../../../shared/sessionSlug'
import type { Db } from '../types'

/**
 * Give every session without a slug one that is unique within its state: the
 * slug its name asks for (sessionToSlug, as tenants compute it), or, when
 * another session of the state holds that, the first free of "-2", "-3", and
 * so on. Lowest session id first, so on the first run after migration 0031 an
 * older session keeps the plain slug, and existing bill URLs keep meaning what
 * they meant. A slug, once assigned, never changes.
 *
 * Runs on every cron tick and after every session write. Several jobs may run
 * it at once: each write claims a slug only if no other session of the state
 * holds it, in one statement, so two sessions can never take the same one.
 */
export async function assignSessionSlugs(db: Db): Promise<void> {
  const pending = await db.select({ sessionId: sessions.sessionId, state: sessions.state, sessionName: sessions.sessionName })
    .from(sessions).where(isNull(sessions.slug)).orderBy(asc(sessions.sessionId)).all()
  if (pending.length === 0) return

  const taken = new Map<string, Set<string>>()
  const takenIn = async (state: string) => {
    let set = taken.get(state)
    if (!set) {
      const rows = await db.select({ slug: sessions.slug }).from(sessions)
        .where(and(eq(sessions.state, state), isNotNull(sessions.slug))).all()
      set = new Set(rows.map(r => r.slug!))
      taken.set(state, set)
    }
    return set
  }

  for (const s of pending) {
    const wanted = sessionToSlug(s.sessionName) || 'session'
    const used = await takenIn(s.state)
    for (let n = 1; ; n++) {
      const slug = n === 1 ? wanted : `${wanted}-${n}`
      if (used.has(slug)) continue
      const claimed = await db.update(sessions).set({ slug })
        .where(and(
          eq(sessions.sessionId, s.sessionId),
          isNull(sessions.slug),
          sql`NOT EXISTS (SELECT 1 FROM sessions other WHERE other.state = ${s.state} AND other.slug = ${slug})`,
        ))
        .run()
      if (claimed.meta.changes > 0) {
        used.add(slug)
        break
      }
      // Another job got here first: it slugged this session, or took the slug.
      const now = await db.select({ slug: sessions.slug }).from(sessions).where(eq(sessions.sessionId, s.sessionId)).get()
      if (!now || now.slug !== null) break
      used.add(slug)
    }
  }
}
