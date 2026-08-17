import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './db/schema'
import type { AuthVariables } from './middleware/auth'
import type { RateLimiter } from '../../shared/rateLimit'

export type AppEnv = {
  Bindings: Env
  Variables: AuthVariables
}

export type Env = {
  DB: D1Database
  BILLS_BUCKET?: R2Bucket
  BILL_QUEUE?: Queue
  RESEND_API_KEY: string
  // AI Gateway (unified billing) — gateway-routed path
  CF_AIG_TOKEN?: string        // Account-level CF token with AI Gateway Run scope
  CF_ACCOUNT_ID?: string       // Cloudflare account ID
  CF_AIG_GATEWAY?: string      // AI Gateway slug
  AI_GATEWAY_ENABLED?: string  // "true" to route through gateway; unset = rollback to direct key
  // Rollback key — keep set for one release after gateway is confirmed stable, then remove
  GEMINI_API_KEY?: string
  APP_URL: string
  APP_DOMAINS?: string      // comma-separated registrable domains served; drives CORS apex + superadmin cookie scope. Empty/unset = same-origin only + host-only cookie.
  EMAIL_FROM?: string       // full sender address; defaults to notifications@example.com
  EMAIL_FROM_BULK?: string  // sender for bulk mail (digest, week-ahead); segments reputation onto a dedicated sending subdomain (e.g. mail.floor.vote). Falls back to EMAIL_FROM when unset.
  EMAIL_REPLY_TO?: string   // reply-to address; defaults to EMAIL_FROM
  ASSOCIATION_NAME?: string
  OPERATOR_NAME?: string            // sidebar footer operator label; empty = no name line
  OPERATOR_URL?: string             // operator credit link target; empty = unlinked
  OPERATOR_CONTACT_EMAILS?: string  // comma-separated support recipients; empty = no contact / feedback disabled
  STATE?: string
  TENANT_ID: string
  CENTRAL_API_URL: string
  CENTRAL_ADMIN_SECRET?: string
  PROVIDER?: string
  CENTRAL?: Fetcher
  ASSETS: Fetcher
  ALERT_EMAILS?: string  // recipients of ops/cron-failure alerts
  SUPERADMIN_JWT_PUBLIC_KEY?: string  // ES256 public JWK (JSON string); verifies central-issued superadmin tokens
  INSTANCE_DOMAINS?: string
  CALENDAR_DEFAULT_TZ?: string
  DEMO_MODE?: string
  DEMO_SEED?: string  // demoSeeds registry key; defaults to nj-county-clerks
  LIST_CACHE_TTL?: string  // GET /bills page-query cache TTL (seconds); default 0 (off), set per-tenant to enable
  EMAIL_PROVIDER?: string
  EMAIL?: import('./lib/email').CloudflareEmailBinding
  // Workers Rate Limiting binding for the unauthenticated magic-link POST
  // (`[[ratelimits]]` in wrangler.toml, per tenant env). Optional: absent in dev/
  // tests → checkRateLimit fails open.
  LOGIN_RATE_LIMITER?: RateLimiter
  // Workers Rate Limiting binding for the additive writes a DEMO_MODE tenant
  // allows. Demo auto-login hands any caller a session with no interaction, so
  // those writes are anonymous by construction and keyed per-IP in demoReadOnly.
  // Optional, and only worth declaring on demo tenants: absent → checkRateLimit
  // fails open, which is what keeps this safe for tenants (and tests) that never
  // bind it.
  DEMO_WRITE_RATE_LIMITER?: RateLimiter
  // Cloudflare Turnstile secret (siteverify). Unset → gate fails open (stub).
  // Set by the operator after creating a widget.
  TURNSTILE_SECRET_KEY?: string
  // Public Cloudflare Turnstile sitekey, served to the login page via the public
  // /auth/demo-mode bootstrap. Unset → the login form renders no widget (fail-open,
  // mirrors the TURNSTILE_SECRET_KEY server gate). A var, not a secret.
  TURNSTILE_SITE_KEY?: string
}

export type AppDb = DrizzleD1Database<typeof schema>

export type TenantQueueMessage = {
  tenantId: string
  billId: string // "legiscan:{bill_id}" or "ocd-bill/{uuid}"
  forceMetadata?: boolean // Skip providerUpdatedAt dedup; re-upsert metadata; still gates AI on keywords
  forceAI?: boolean // Skip dedup AND keyword gate; always run Claude
  interactive?: true     // Set ONLY by promote-bill and reprocess-bill routes; never inferred
  stubOnly?: boolean // Update stub metadata only; skip full bill fetch and AI
  metadataOnly?: boolean // Refresh metadata from central; skip text fetch + AI.
  matchType?: 'keyword' | 'manual' | null // Bill's match classification for this tenant
  changes?: {
    changeType: string
    oldValue: string | null
    newValue: string | null
    detail: string | null
    detectedAt: string
  }[]
  calendar?: {
    events: {
      identityKey: string
      date: string | null
      time: string | null
      location: string | null
      description: string | null
      eventHash: string | null
    }[]
    changes: {
      changeType: 'hearing_added' | 'hearing_changed' | 'hearing_cancelled'
      identityKey: string
      date: string | null
      time: string | null
      location: string | null
      description: string | null
      eventHash: string | null
    }[]
  }
}

export type InviteEmailMessage = {
  type: 'invite-email'
  tenantId: string
  userId: string
  email: string
}

// Bodies that can appear on a tenant's BILL_QUEUE. Bill notifications have no
// `type` discriminant (legacy shape); invite jobs set type: 'invite-email'.
export type QueueMessage = TenantQueueMessage | InviteEmailMessage
