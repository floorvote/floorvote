import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { sessions, stateProviders } from '../db/schema'
import { DEFAULT_PROVIDER_ID } from '../providers'
import { firstFreeSlug, sessionToSlug } from '../../../shared/sessionSlug'
import type { Db } from '../types'

/**
 * Give every session without a slug one that is unique within its state: the
 * slug its name asks for (sessionToSlug, as tenants compute it), or, when
 * another session of the state holds that, the first free of "-2", "-3", and
 * so on. Sessions of the provider that owns their state go first (a state with
 * no state_providers row is LegiScan's), then lowest session id. On the first
 * run after migration 0031, the URLs instances already use keep meaning what
 * they meant: a LegiScan state's sessions keep the plain slug, and so do a
 * LIMS-owned DC's Council Periods beside older LegiScan DC sessions. Callers
 * load ownership first (loadStateOwners), so env-var ownership is seeded
 * before the first run. A slug, once assigned, never changes.
 *
 * Runs on every cron tick and after every session write. Several jobs may run
 * it at once: each write claims a slug only if no other session of the state
 * holds it, in one statement, so two sessions can never take the same one.
 */
export async function assignSessionSlugs(db: Db): Promise<void> {
  const pending = await db.select({ sessionId: sessions.sessionId, state: sessions.state, sessionName: sessions.sessionName })
    .from(sessions)
    .leftJoin(stateProviders, eq(stateProviders.state, sessions.state))
    .where(isNull(sessions.slug))
    .orderBy(
      sql`CASE WHEN COALESCE(${stateProviders.provider}, ${DEFAULT_PROVIDER_ID}) = ${sessions.provider} THEN 0 ELSE 1 END`,
      asc(sessions.sessionId))
    .all()
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
    for (;;) {
      const slug = firstFreeSlug(wanted, used)
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
