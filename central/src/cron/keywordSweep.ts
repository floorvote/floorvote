import { eq, and } from 'drizzle-orm'
import { sessions, bills, billTenants, tenants, keywordRegistry } from '../db/schema'
import { nowDb } from '../lib/dbTime'
import { isWildcardKeyword } from '../lib/keywords'
import type { BillProvider } from '../providers/types'
import type { Env, CentralDb, IngestorQueueMessage } from '../types'

export async function runKeywordSweep(env: Env, db: CentralDb, provider: BillProvider): Promise<void> {
  const kwFilteredTenants = await db.select().from(tenants)
    .where(and(eq(tenants.active, true), eq(tenants.ingestionMode, 'keyword-filtered')))
    .all()
  if (kwFilteredTenants.length === 0) return

  const allSessions = await db.select().from(sessions)
    .where(eq(sessions.isCurrent, true))
    .all()
  if (allSessions.length === 0) return

  const now = nowDb()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

  for (const tenant of kwFilteredTenants) {
    let coverage: string[]
    try { coverage = JSON.parse(tenant.stateCoverage) } catch { continue }
    const hasWildcard = coverage.includes('*')

    const kwRows = await db.select().from(keywordRegistry)
      .where(eq(keywordRegistry.tenantId, tenant.tenantId))
      .all()
    const keywords = kwRows.map(r => r.keyword)
    if (keywords.length === 0) continue

    const linkedRows = await db.select({ billId: billTenants.billId })
      .from(billTenants)
      .where(eq(billTenants.tenantId, tenant.tenantId))
      .all()
    const linkedIds = new Set(linkedRows.map(r => r.billId))

    const toLink: { billId: string; keyword: string }[] = []
    const toQueue: IngestorQueueMessage[] = []

    for (const session of allSessions) {
      if (!hasWildcard && !coverage.includes(session.state)) continue

      for (const keyword of keywords) {
        // The wildcard sentinel is not a provider query — sending it would become
        // a literal `q=*` (or `q=**`, `q=***`, ...) and 400 the whole sweep. A
        // wildcard tenant already receives every bill through the normal sync
        // path, so it needs no sweep. Use isWildcardKeyword rather than an
        // equality check against WILDCARD_KEYWORD: shared/keywords.ts treats
        // any all-asterisk string (and one with surrounding whitespace) as the
        // wildcard, and an equality check would only catch the exact '*'.
        if (isWildcardKeyword(keyword)) continue

        // Strip glob stars before sending to the provider: the provider's
        // full-text search has no glob semantics of its own and would reject
        // or silently no-op on a literal '*'. Widening the query this way is
        // safe in the direction that matters — the local matcher (matchesUnion)
        // re-filters every result against the real glob pattern afterward, so
        // a broader provider query can only add candidates that get filtered
        // back out, never let through something that shouldn't match.
        // '#' is stripped for the same reason and with the same safety: it
        // stands for a digit the provider cannot express, so sending `5.#`
        // literally would search for a '#' no bill text contains and return
        // nothing. Dropping it searches `5.` instead — broader, then narrowed
        // by matchesUnion below, which is the direction that stays correct.
        //
        // This path is OpenStates-only, and reading it as proof that keyword
        // patterns reach a provider's search API is the mistake it invites.
        // LegiScan's fetchKeywordMatches is an empty generator ("LegiScan
        // doesn't support keyword search via this interface"), and the
        // deployed LegiScan entrypoint (index-legiscan.ts) never calls this
        // sweep at all — its cron pulls the session masterlist and matches
        // locally. So for a LegiScan tenant every keyword, `#` and all, is
        // evaluated only by matchesUnion against text already in hand.
        const providerQuery = keyword.replace(/[*#]/g, '')

        for await (const stub of provider.fetchKeywordMatches(session.state, session.identifier, providerQuery, since24h)) {
          if (linkedIds.has(stub.id)) continue
          linkedIds.add(stub.id)

          await db.insert(bills).values({
            billId: stub.id,
            sessionId: session.sessionId,
            state: session.state,
            number: stub.number,
            title: stub.title,
            abstract: stub.abstract,
            status: stub.status,
            statusDate: stub.statusDate,
            lastAction: stub.lastAction,
            lastActionDate: stub.lastActionDate,
            openstatesUrl: stub.url,
            stateUrl: stub.stateUrl,
            updatedAt: stub.updatedAt,
            createdAt: now,
          }).onConflictDoNothing()

          toLink.push({ billId: stub.id, keyword })
          toQueue.push({ billId: stub.id })
        }
      }
    }

    for (let i = 0; i < toLink.length; i += 25) {
      await db.insert(billTenants)
        .values(toLink.slice(i, i + 25).map(l => ({
          billId: l.billId,
          tenantId: tenant.tenantId,
          matchedKeyword: l.keyword,
        })))
        .onConflictDoNothing()
    }

    if (toQueue.length > 0) {
      for (let i = 0; i < toQueue.length; i += 100) {
        await env.INGESTOR_QUEUE.sendBatch(
          toQueue.slice(i, i + 100).map(body => ({ body })),
        )
      }
      console.log(`[keyword-sweep] tenant=${tenant.tenantId}: queued ${toQueue.length} new matches`)
    }
  }

  for (const session of allSessions) {
    await db.update(sessions)
      .set({ lastKeywordSweepAt: now })
      .where(eq(sessions.sessionId, session.sessionId))
  }
}
