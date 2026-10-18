import { asc, eq, sql } from 'drizzle-orm'
import { apiCallLog, people } from '../db/schema'
import { nowDb } from './dbTime'
import { knownProviderIds, providerIdsFor } from './providerIds'
import { providerCacheDrop, providerCacheList, providerCachePut } from './providerCache'
import { escHtml, sendOpsAlert } from './jobAlert'
import { PRODUCT_NAME } from '../../../shared/brand'
import type { Provider, ProviderContext } from '../providers'
import type { Env, Db } from '../types'

/**
 * What core hands a provider: a frozen copy of only the env keys it declared,
 * a call log that writes each outbound API call to api_call_log, the reads
 * and id minting a provider may need, done by core, and an ops alert to the
 * operators. `logParams` are added to every logged call's params, so a caller
 * can record why it spent the calls.
 */
export function providerContext(
  provider: Provider,
  env: Env,
  db: Db,
  logParams: Record<string, unknown> = {},
): ProviderContext {
  return {
    env: providerEnv(provider, env),
    logCall(callType, params) {
      db.insert(apiCallLog)
        .values({ loggedAt: nowDb(), callType, params: JSON.stringify({ ...params, ...logParams }) })
        .catch(err => console.error('[rate-limit] failed to log API call:', err))
    },
    today: nowDb().slice(0, 10),
    ids: (kind, nativeKeys) => providerIdsFor(db, provider.id, kind, nativeKeys),
    knownIds: (kind, nativeKeys) => knownProviderIds(db, provider.id, kind, nativeKeys),
    cache: {
      list: prefix => providerCacheList(db, provider.id, prefix),
      put: entries => providerCachePut(db, provider.id, entries),
      drop: keys => providerCacheDrop(db, provider.id, keys),
    },
    // People a cutover carried over (lib/carriedIds.ts) come last, so a
    // provider that indexes them by name, latest first (LIMS), keeps giving a
    // legislator the id instances already have, even once the provider lists
    // them under a new id of its own (a new Council Period, say).
    people: () => db.select({ peopleId: people.peopleId, name: people.name, role: people.role })
      .from(people)
      .where(eq(people.provider, provider.id))
      .orderBy(
        asc(sql`EXISTS (SELECT 1 FROM cutover_people cp JOIN cutovers c ON c.id = cp.cutover_id
          WHERE cp.people_id = ${people.peopleId} AND c.to_provider = ${provider.id} AND c.undone_at IS NULL)`),
        asc(people.peopleId))
      .all(),
    alert: ({ subject, text }) => sendOpsAlert(env, {
      subject: `[${PRODUCT_NAME}] ${provider.id}: ${subject}`,
      text,
      html: `<pre style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.6; color: #0f172a;">${escHtml(text)}</pre>`,
    }),
  }
}

/** A frozen copy of only the env keys a provider declared. */
export function providerEnv(provider: Provider, env: Env): ProviderContext['env'] {
  return Object.freeze(Object.fromEntries(provider.envKeys.map(key => [key, env[key]])))
}
