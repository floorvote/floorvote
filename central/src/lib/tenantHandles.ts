import { resolveTenantRpc } from './tenantRpc'
import type { Env } from '../types'

/**
 * Whether central may name bills to an instance by the neutral handle
 * (`bill:<n>`, release 2 of #305), asked of the instance over its CentralApi
 * binding (`capabilities()`). An instance that predates release 1 would store
 * a neutral handle as a second bill and build new calendar UIDs from it, so
 * anything short of a clear yes is no: no binding (an instance reached only by
 * queue id), a binding without the method (release 1 or older), a failed call,
 * or any answer but `neutralHandles: true`.
 *
 * The answer is kept for `HANDLE_FORM_TTL_MS`, yes or no, so a busy fan-out
 * asks each instance about once a minute, and an instance rolled back after
 * saying yes gets legacy handles again within that time.
 */
export const HANDLE_FORM_TTL_MS = 60_000

// Keyed by the binding itself, so an answer never outlives the binding it came from.
const answers = new WeakMap<object, { neutral: boolean; until: number }>()

export async function sendsNeutralHandles(env: object, tenantId: string, now = Date.now()): Promise<boolean> {
  const rpc = resolveTenantRpc(env as Env, tenantId)
  if (!rpc || typeof rpc !== 'object') return false
  const cached = answers.get(rpc)
  if (cached && now < cached.until) return cached.neutral
  let neutral = false
  try {
    neutral = (await rpc.capabilities())?.neutralHandles === true
  } catch {
    neutral = false
  }
  answers.set(rpc, { neutral, until: now + HANDLE_FORM_TTL_MS })
  return neutral
}
