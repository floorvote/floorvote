import { apiCallLog } from '../db/schema'
import { nowDb } from './dbTime'
import type { Provider, ProviderContext } from '../providers'
import type { Env, Db } from '../types'

/**
 * What core hands a provider: a frozen copy of only the env keys it declared,
 * and a call log that writes each outbound API call to api_call_log.
 * `logParams` are added to every logged call's params, so a caller can record
 * why it spent the calls.
 */
export function providerContext(
  provider: Provider,
  env: Env,
  db: Db,
  logParams: Record<string, unknown> = {},
): ProviderContext {
  return {
    env: Object.freeze(Object.fromEntries(provider.envKeys.map(key => [key, env[key]]))),
    logCall(callType, params) {
      db.insert(apiCallLog)
        .values({ loggedAt: nowDb(), callType, params: JSON.stringify({ ...params, ...logParams }) })
        .catch(err => console.error('[rate-limit] failed to log API call:', err))
    },
  }
}
