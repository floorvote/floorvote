import type { Env } from '../types'

/**
 * Fetch from central Worker.
 *
 * Production (service binding present): central exposes a named `TenantApi`
 * WorkerEntrypoint that is reachable ONLY over same-account bindings, never the
 * public internet. It injects the admin secret server-side, so we do NOT attach
 * `x-admin-secret` here — this OUTBOUND path no longer transmits the secret.
 * (The tenant still holds `CENTRAL_ADMIN_SECRET` for the INBOUND direction:
 * central→tenant calls to `/api/internal/*` — e.g. the engagement-stats pull —
 * are still HTTP and validated against it. So the secret is not removed from
 * tenants by this change.)
 *
 * Local dev (no binding): fall back to a plain HTTP fetch against
 * CENTRAL_API_URL, which still requires the shared `x-admin-secret` header
 * (verified by central's route middleware). CENTRAL_ADMIN_SECRET lives in
 * api/.dev.vars for this path too.
 *
 * Cloudflare blocks outbound fetch() to *.workers.dev from within a Worker
 * (error 1042); the CENTRAL binding bypasses that for Worker-to-Worker calls.
 *
 * Central's machine API is mounted under `/api/*` (so its prefixes no longer
 * shadow the dashboard SPA's client routes). Callers still pass the bare path
 * (`/bills/...`, `/tenants/...`, `/admin/...`); this is the single place that
 * prepends `/api`. Both central envs (legiscan + OpenStates) serve `/api/*`.
 *
 * IMPORTANT: the LegiScan central `TenantApi` entrypoint is DENY-BY-DEFAULT
 * (central/src/lib/tenantSurface.ts). A path NOT on that allowlist is 403'd
 * before it reaches the route — silently, on every tenant. When you add a new
 * `centralFetch(...)` path here, you MUST also add it to ALLOW in tenantSurface.ts
 * and to the canonical caller list in tenantSurface.test.ts.
 */
export function centralFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const apiPath = `/api${path}`
  if (env.CENTRAL) {
    return env.CENTRAL.fetch(new Request(`https://central${apiPath}`, init))
  }

  const headers = {
    ...(init?.headers as Record<string, string> | undefined),
    'x-admin-secret': env.CENTRAL_ADMIN_SECRET ?? '',
  }
  return fetch(`${env.CENTRAL_API_URL}${apiPath}`, { ...init, headers })
}
