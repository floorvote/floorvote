/**
 * Per-tenant delivery queues are reached through wrangler producer bindings that
 * follow a fixed naming convention: tenant id "my-org" → binding
 * TENANT_QUEUE_MY_ORG. Bindings are declared statically in
 * central/wrangler.toml, so a tenant with no binding resolves to `undefined` and
 * its bills are silently dropped — callers must treat `undefined` as a
 * misconfiguration, not a normal case.
 *
 * Shared by both central envs (OpenStates `Env` and LegiScan `LsEnv`); takes a
 * loosely-typed env so neither type needs an index signature.
 */

/** The wrangler binding name central uses to reach a tenant's delivery queue. */
export function tenantQueueBindingName(tenantId: string): string {
  return `TENANT_QUEUE_${tenantId.toUpperCase().replace(/-/g, '_')}`
}

/** Resolve a tenant's per-tenant queue producer binding, or `undefined` if none is configured. */
export function getTenantQueue(env: object, tenantId: string): Queue | undefined {
  return (env as Record<string, unknown>)[tenantQueueBindingName(tenantId)] as Queue | undefined
}
