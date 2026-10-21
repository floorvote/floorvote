// ── Hybrid per-tenant delivery ────────────────────────────────────────────
// Single chokepoint for sending bills to a tenant's delivery queue. Binding-first:
// tenants with a static TENANT_QUEUE_<ID> producer binding (the existing 3) take
// the exact same queue.send / queue.sendBatch path as before — byte-for-byte
// unchanged. Tenants WITHOUT a binding fall back to HTTP publish by queue_id,
// which is what makes onboarding self-service (no central redeploy). When neither
// is available the message is dropped and the caller logs it.
//
// It is also where a message's bill handle takes the form the instance reads
// (#305): `bill:<n>` for an instance whose CentralApi binding reports neutral
// handles, `legiscan:<n>` for any other (lib/tenantHandles.ts), whatever form
// the caller built. Every message to an instance names its bill in `billId`.

import { getTenantQueue } from './tenantQueue'
import { publishMessage, publishBatch, queuesRestEnabled } from './queuesRest'
import { inTenantForm } from './billHandle'
import { sendsNeutralHandles } from './tenantHandles'

type DeliveryEnv = { CF_QUEUES_TOKEN?: string; CF_ACCOUNT_ID?: string; [key: string]: unknown }

/** Mirrors the queue.sendBatch(100) cap used on the binding path. */
const BATCH_MAX = 100

export type DeliveryOutcome = 'binding' | 'http' | 'dropped' | 'noop'

const billIdOf = (body: unknown): string | null => {
  const id = body && typeof body === 'object' ? (body as { billId?: unknown }).billId : undefined
  return typeof id === 'string' ? id : null
}

/** The bodies with each `billId` in the form the instance reads. Asks the instance only when one names a bill. */
async function inTenantHandleForm(env: DeliveryEnv, tenantId: string, bodies: unknown[]): Promise<unknown[]> {
  if (!bodies.some(b => billIdOf(b) !== null)) return bodies
  const neutral = await sendsNeutralHandles(env, tenantId)
  return bodies.map(b => {
    const id = billIdOf(b)
    return id === null ? b : { ...(b as object), billId: inTenantForm(id, neutral) }
  })
}

/** Deliver one message to a tenant. Binding-first, HTTP fallback by queueId. */
export async function deliverToTenant(
  env: DeliveryEnv,
  tenantId: string,
  queueId: string | null,
  body: unknown,
): Promise<DeliveryOutcome> {
  const binding = getTenantQueue(env, tenantId)
  if (!binding && !(queueId && queuesRestEnabled(env))) return 'dropped'
  const [sent] = await inTenantHandleForm(env, tenantId, [body])
  if (binding) {
    await binding.send(sent)
    return 'binding'
  }
  await publishMessage(env, queueId!, sent)
  return 'http'
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
  if (!binding && !(queueId && queuesRestEnabled(env))) return 'dropped'
  const sent = await inTenantHandleForm(env, tenantId, bodies)
  if (binding) {
    for (let i = 0; i < sent.length; i += BATCH_MAX) {
      await binding.sendBatch(sent.slice(i, i + BATCH_MAX).map((b) => ({ body: b })))
    }
    return 'binding'
  }
  await publishBatch(env, queueId!, sent)
  return 'http'
}
