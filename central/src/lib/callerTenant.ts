import type { MiddlewareHandler } from 'hono'
import type { LsEnv } from '../types-legiscan'

/**
 * Object-level authorization for tenant-scoped central routes reachable via the
 * `TenantApi` service binding.
 *
 * The deny-by-default allowlist (`./tenantSurface`) limits WHICH operations a
 * tenant can reach over the binding, but the routes take `:tenantId` (or
 * `body.tenantId`) as a param — so nothing stops tenant A from targeting tenant
 * B's objects. `TenantApi` (`../index-legiscan`) closes that by injecting
 * `x-caller-tenant` from the unforgeable per-binding prop `ctx.props.tenantId`
 * (Cloudflare guarantees props are set only by authorized deployments). When the
 * header is present, the caller may act ONLY on its own tenantId.
 *
 * Absent header ⇒ NOT a props-carrying binding call: either central's public
 * HTTP `/api/*` path (operator with the real `x-admin-secret`, legitimately
 * cross-tenant) or a tenant not yet redeployed with the prop (the rollout
 * window). Both are allowed — the guard auto-activates per tenant the moment its
 * prop ships, so there is no separate "enforce" flip and no downtime.
 */
export const CALLER_TENANT_HEADER = 'x-caller-tenant'

/** True iff a props-carrying caller is targeting a DIFFERENT tenant's objects. */
function isCrossTenant(caller: string | undefined, target: string | undefined): boolean {
  if (!caller) return false // not a props-carrying binding call → don't enforce
  return target !== caller // a missing/blank target also mismatches ⇒ denied
}

function forbidden(): Response {
  return Response.json({ error: 'forbidden: cross-tenant access denied' }, { status: 403 })
}

/** Guard a route whose target tenant is a path param (default `:tenantId`). */
export function guardCallerTenantParam(param = 'tenantId'): MiddlewareHandler<{ Bindings: LsEnv }> {
  return async (c, next) => {
    const params = c.req.param() as Record<string, string | undefined>
    if (isCrossTenant(c.req.header(CALLER_TENANT_HEADER), params[param])) {
      return forbidden()
    }
    return next()
  }
}

/** Guard a route whose target tenant is a JSON body field (default `tenantId`). */
export function guardCallerTenantBody(field = 'tenantId'): MiddlewareHandler<{ Bindings: LsEnv }> {
  return async (c, next) => {
    const caller = c.req.header(CALLER_TENANT_HEADER)
    // Only parse the body when a props-carrying caller could be denied; the
    // public-HTTP / pre-migration path must not consume the request body.
    if (caller) {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
      const target = typeof body?.[field] === 'string' ? (body[field] as string) : undefined
      if (isCrossTenant(caller, target)) return forbidden()
    }
    return next()
  }
}
