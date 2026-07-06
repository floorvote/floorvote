// ── Hybrid per-tenant delivery ────────────────────────────────────────────
// Single chokepoint for sending bills to a tenant's delivery queue. Binding-first:
// tenants with a static TENANT_QUEUE_<ID> producer binding (the existing 3) take
// the exact same queue.send / queue.sendBatch path as before — byte-for-byte
// unchanged. Tenants WITHOUT a binding fall back to HTTP publish by queue_id,
// which is what makes onboarding self-service (no central redeploy). When neither
// is available the message is dropped and the caller logs it.

import { getTenantQueue } from './tenantQueue'
import { publishMessage, publishBatch, queuesRestEnabled } from './queuesRest'

type DeliveryEnv = { CF_QUEUES_TOKEN?: string; CF_ACCOUNT_ID?: string; [key: string]: unknown }

/** Mirrors the queue.sendBatch(100) cap used on the binding path. */
const BATCH_MAX = 100

export type DeliveryOutcome = 'binding' | 'http' | 'dropped' | 'noop'

/** Deliver one message to a tenant. Binding-first, HTTP fallback by queueId. */
export async function deliverToTenant(
  env: DeliveryEnv,
  tenantId: string,
  queueId: string | null,
  body: unknown,
): Promise<DeliveryOutcome> {
  const binding = getTenantQueue(env, tenantId)
  if (binding) {
    await binding.send(body)
    return 'binding'
  }
  if (queueId && queuesRestEnabled(env)) {
    await publishMessage(env, queueId, body)
    return 'http'
  }
  return 'dropped'
}

/** Deliver many messages to a tenant. Binding-first (chunked), HTTP fallback by queueId. */
export async function deliverBatchToTenant(
  env: DeliveryEnv,
  tenantId: string,
  queueId: string | null,
  bodies: unknown[],
): Promise<DeliveryOutcome> {
  if (bodies.length === 0) return 'noop'
  const binding = getTenantQueue(env, tenantId)
  if (binding) {
    for (let i = 0; i < bodies.length; i += BATCH_MAX) {
      await binding.sendBatch(bodies.slice(i, i + BATCH_MAX).map((b) => ({ body: b })))
    }
    return 'binding'
  }
  if (queueId && queuesRestEnabled(env)) {
    await publishBatch(env, queueId, bodies)
    return 'http'
  }
  return 'dropped'
}
