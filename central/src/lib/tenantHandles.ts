import { resolveTenantRpc, tenantRpcBindingName } from './tenantRpc'
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

// By the tenant's binding name (TENANT_<ID>), so every spelling of a tenant id
// that reaches the same binding shares one answer. Not by the binding object,
// which the runtime may hand out fresh on each invocation. A tenant's binding
// can't change within an isolate (bindings are fixed per central deploy), and a
// tenant rolled back to release 1 within the TTL still reads neutral handles
// correctly, so a cached yes is safe for its whole life.
const answers = new Map<string, { neutral: boolean; until: number }>()

/** Forget every cached answer. For tests, which reuse tenant ids with different bindings. */
export function forgetHandleForms(): void {
  answers.clear()
}

export async function sendsNeutralHandles(env: object, tenantId: string, now = Date.now()): Promise<boolean> {
  const rpc = resolveTenantRpc(env as Env, tenantId)
  if (!rpc) return false
  const key = tenantRpcBindingName(tenantId)
  const cached = answers.get(key)
  if (cached && now < cached.until) return cached.neutral
  let neutral = false
  try {
    neutral = (await rpc.capabilities())?.neutralHandles === true
  } catch {
    neutral = false
  }
  answers.set(key, { neutral, until: now + HANDLE_FORM_TTL_MS })
  return neutral
}
