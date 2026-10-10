import { asc, eq } from 'drizzle-orm'
import { apiCallLog, people } from '../db/schema'
import { nowDb } from './dbTime'
import { providerIdsFor } from './providerIds'
import type { Provider, ProviderContext } from '../providers'
import type { Env, Db } from '../types'

/**
 * What core hands a provider: a frozen copy of only the env keys it declared,
 * a call log that writes each outbound API call to api_call_log, and the reads
 * and id minting a provider may need, done by core. `logParams` are added to
 * every logged call's params, so a caller can record why it spent the calls.
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
    people: () => db.select({ peopleId: people.peopleId, name: people.name, role: people.role })
      .from(people)
      .where(eq(people.provider, provider.id))
      .orderBy(asc(people.peopleId))
      .all(),
  }
}

/** A frozen copy of only the env keys a provider declared. */
export function providerEnv(provider: Provider, env: Env): ProviderContext['env'] {
  return Object.freeze(Object.fromEntries(provider.envKeys.map(key => [key, env[key]])))
}
