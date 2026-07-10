import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './db/schema-legiscan'
import type { RateLimiter } from '../../shared/rateLimit'

export type LsEnv = {
  DB: D1Database
  BILLS_BUCKET: R2Bucket
  INGESTOR_QUEUE: Queue
  LEGISCAN_API_KEY: string
  ADMIN_SECRET: string
  OPERATOR_NAME: string
  BILL_PROVIDER: 'legiscan'
  RESEND_API_KEY?: string
  EMAIL?: import('./lib/email').CloudflareEmailBinding
  EMAIL_PROVIDER?: string
  EMAIL_FROM?: string       // full sender address; defaults to notifications@example.com
  EMAIL_REPLY_TO?: string   // reply-to; defaults to EMAIL_FROM
  SUPERADMIN_EMAILS?: string
  SUPERADMIN_JWT_PRIVATE_KEY?: string  // ES256 private JWK (JSON string); central-only secret. Sole issuer.
  SUPERADMIN_JWT_PUBLIC_KEY?: string   // ES256 public JWK (JSON string); var, not secret.
  ALERT_EMAILS?: string  // recipients of ops/cron-failure alerts; distinct from SUPERADMIN_EMAILS (access)
  CF_ANALYTICS_TOKEN?: string  // CF API token (Account Analytics: Read + D1 read + Zone Analytics: Read) for anomaly watch + email delivery
  CF_FLOORVOTE_ZONE_ID?: string  // Cloudflare zone id for emailSendingAdaptive GraphQL dataset
  CF_ACCOUNT_ID?: string  // Cloudflare account id; used by D1 list + analytics GraphQL queries
  CF_EMAIL_TOKEN?: string  // CF API token (Email Sending: Read) for suppression-list checks
  D1_ANOMALY_FACTOR?: string  // rows-read spike multiple over baseline (default 5)
  D1_ANOMALY_FLOOR?: string  // minimum rows-read to consider a spike (default 50,000,000)
  D_LATENCY_THRESHOLD_MS?: string  // engagement-pull latency (ms) above which a tenant is flagged slow (default 3000)
  BILL_TEXT_CACHE_TTL?: string  // GET /bills/:id/text cache TTL in seconds (default 300; 0 disables)
  CF_QUEUES_TOKEN?: string  // CF API token (Queues: Edit) for dynamic per-tenant queue create + HTTP publish
  TENANT_QUEUE_PREFIX?: string  // prefix for dynamic queue-name resolution: `${prefix}-<tenantId>-queue` (default "floorvote"). Set to match your tenant queue naming if you rename resources (e.g. "acme").
  ADMIN_APP_URL?: string
  ASSETS?: Fetcher
  // Workers Rate Limiting binding for the unauthenticated dashboard /login POST
  // (`[[env.legiscan.ratelimits]]`). Optional: absent in dev/tests → fails open. (Task4)
  LOGIN_RATE_LIMITER?: RateLimiter
  // Cloudflare Turnstile secret (siteverify). Unset → gate fails open (stub). (Task4)
  TURNSTILE_SECRET_KEY?: string
  // Public Cloudflare Turnstile sitekey, served to the dashboard login via the
  // public GET /admin/dash/auth/config. Unset → no widget (fail-open, mirrors the
  // secret gate). A var, not a secret.
  TURNSTILE_SITE_KEY?: string
  [key: string]: unknown
}

export type LsDb = DrizzleD1Database<typeof schema>

export type LsIngestorMessage = {
  billId: number
  forceMetadata?: boolean
  forceAI?: boolean  // propagate to tenant notification so tenant re-runs AI even if text unchanged
  interactive?: boolean  // relay from tenant promote-bill request; false = background
  skipFetch?: boolean  // skip LegiScan getBill API call; use existing DB data + download text from state_link
}

export type CalendarBlock = {
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

export type LsNotificationMessage = {
  tenantId: string
  billId: string   // "legiscan:{bill_id}"
  forceMetadata?: boolean
  forceAI?: boolean
  interactive?: true     // only set when true; omitted for all background paths
  stubOnly?: boolean // Update stub metadata only; skip full bill fetch and AI
  metadataOnly?: boolean // Refresh metadata from central; skip text fetch + AI.
  matchType?: 'keyword' | 'manual' | null
  changes?: {
    changeType: string
    oldValue: string | null
    newValue: string | null
    detail: string | null
    detectedAt: string
  }[]
  calendar?: CalendarBlock
}
