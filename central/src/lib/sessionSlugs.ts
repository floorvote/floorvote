import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { sessions, stateProviders } from '../db/schema'
import { DEFAULT_PROVIDER_ID } from '../providers'
import { firstFreeSlug, sessionToSlug } from '../../../shared/sessionSlug'
import type { Db } from '../types'

/** Claims per batch: a round trip each would pass D1's per-invocation query limit. */
const CLAIM_BATCH = 50

/**
 * Give every session without a slug one that is unique within its state: the
 * slug its name asks for (sessionToSlug, as tenants compute it), or, when
 * another session of the state holds that, the first free of "-2", "-3", and
 * so on. Sessions of the provider that owns their state go first (a state with
 * no state_providers row is LegiScan's), then lowest session id. On the first
 * run after migration 0031, the URLs instances already use keep meaning what
 * they meant: a LegiScan state's sessions keep the plain slug, and so do a
 * LIMS-owned DC's Council Periods beside older LegiScan DC sessions. Numbered
 * special sessions and Council Periods ask for a different slug than older
 * releases gave them, and tenants still resolve the old one (legacySessionSlug).
 * A slug, once assigned, never changes.
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

  // Plan every claim first, then send them in batches: on the first run after
  // migration 0031 every session of every tracked state is pending, and one
  // round trip each could pass D1's per-invocation query limit on a central
  // that covers many states. Each claim keeps its guard, so a claim another job
  // beat comes back with no change and is retried one at a time below.
  const plans: { sessionId: number; state: string; wanted: string; slug: string }[] = []
  for (const s of pending) {
    const wanted = sessionToSlug(s.sessionName) || 'session'
    const used = await takenIn(s.state)
    const slug = firstFreeSlug(wanted, used)
    used.add(slug)
    plans.push({ sessionId: s.sessionId, state: s.state, wanted, slug })
  }
  const claim = (p: { sessionId: number; state: string }, slug: string) => db.update(sessions).set({ slug })
    .where(and(
      eq(sessions.sessionId, p.sessionId),
      isNull(sessions.slug),
      sql`NOT EXISTS (SELECT 1 FROM sessions other WHERE other.state = ${p.state} AND other.slug = ${slug})`,
    ))
  const lost: typeof plans = []
  for (let i = 0; i < plans.length; i += CLAIM_BATCH) {
    const chunk = plans.slice(i, i + CLAIM_BATCH)
    const stmts = chunk.map(p => claim(p, p.slug))
    const results = await db.batch(stmts as [typeof stmts[number], ...typeof stmts])
    results.forEach((r, j) => { if (!(r.meta.changes > 0)) lost.push(chunk[j]) })
  }

  // Another job got here first for each of these: it slugged the session, or
  // took the slug. One query finds the sessions it slugged.
  const slugged = lost.length === 0 ? [] : await db.select({ sessionId: sessions.sessionId }).from(sessions)
    .where(and(
      sql`${sessions.sessionId} IN (SELECT value FROM json_each(${JSON.stringify(lost.map(p => p.sessionId))}))`,
      isNotNull(sessions.slug),
    )).all()
  const done = new Set(slugged.map(r => r.sessionId))
  for (const p of lost) {
    if (done.has(p.sessionId)) continue
    const used = await takenIn(p.state)
    for (;;) {
      const slug = firstFreeSlug(p.wanted, used)
      used.add(slug)
      if ((await claim(p, slug).run()).meta.changes > 0) break
      const now = await db.select({ slug: sessions.slug }).from(sessions).where(eq(sessions.sessionId, p.sessionId)).get()
      if (!now || now.slug !== null) break
    }
  }
}
