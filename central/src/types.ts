import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './db/schema'
import type { RateLimiter } from '../../shared/rateLimit'
import type { CalendarKind } from '../../shared/calendarKinds'

export type Env = {
  DB: D1Database
  BILLS_BUCKET: R2Bucket
  INGESTOR_QUEUE: Queue
  /**
   * Name of the tenants' shared dead-letter queue, when central is configured to
   * drain it. Unset means no dead-letter consumer is attached, and the queue
   * handler treats every batch as ingestor work.
   */
  DEAD_LETTER_QUEUE?: string
  LEGISCAN_API_KEY: string
  /**
   * DC Council LIMS developer key (src/providers/lims). Needed for DC to sync
   * from LIMS, which also takes DC's row in the state ownership table.
   */
  LIMS_API_KEY?: string
  /**
   * Virginia LIS API key (src/providers/lis). Optional: with it, Virginia bills
   * carry their text. Without it, they have none.
   */
  LIS_API_KEY?: string
  /**
   * Congress.gov API key, an api.data.gov key (src/providers/govinfo). Optional:
   * with it, GovInfo reads Congress's committee meetings, and shows them on the
   * body calendar and on the calendars of the bills they take up. Without it,
   * those calendars are empty, and nothing else changes. Sent only in the
   * `X-Api-Key` header of a request to api.congress.gov.
   */
  CONGRESS_API_KEY?: string
  /**
   * Comma-separated LIMS category ids to sync (GET LegislationCategories).
   * Default "1,6,13,14,18": bills, resolutions, grant budget modifications,
   * reprogrammings, and oversight hearing/roundtable notices.
   */
  LIMS_CATEGORIES?: string
  /**
   * Ingestor queue for LIMS bills. LIMS answers 429 above about two concurrent
   * requests, so this queue's consumer should run with max_concurrency = 1.
   * Falls back to INGESTOR_QUEUE when unset.
   */
  LIMS_INGESTOR_QUEUE?: Queue
  /**
   * Ingestor queue for Maryland (MGA) bills, so a Maryland cutover's backlog
   * never waits behind LegiScan's, or LegiScan's behind it. The MGA's data
   * comes from one session file, but each bill's text is a separate download
   * paced per isolate, so this queue's consumer should run with
   * max_concurrency = 1. Falls back to INGESTOR_QUEUE when unset.
   */
  MGA_INGESTOR_QUEUE?: Queue
  /**
   * Ingestor queue for Virginia (LIS) bills, for the same reason as
   * MGA_INGESTOR_QUEUE. The LIS paces its requests per isolate too (two a
   * second), so run this queue's consumer at max_concurrency = 1. Falls back
   * to INGESTOR_QUEUE when unset.
   */
  LIS_INGESTOR_QUEUE?: Queue
  ADMIN_SECRET: string
  OPERATOR_NAME: string
  RESEND_API_KEY?: string
  EMAIL?: import('../../shared/emailProviders').CloudflareEmailBinding
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
  CF_AIG_GATEWAY?: string  // AI Gateway slug (e.g. "tracker"); scopes the AI-usage analytics query. Unset → AI usage panel shows "not configured"
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

export type Db = DrizzleD1Database<typeof schema>

/** A message on the ingestor queue: one bill to ingest, or one session's vote dataset to load. */
export type IngestorMessage = BillMessage | VoteDatasetMessage

/**
 * Load one session's per-member votes from its provider's vote dataset
 * (cron/vote-datasets.ts). Shares the ingestor queue so self-hosted configs
 * need no new queue binding.
 */
export type VoteDatasetMessage = {
  kind: 'vote-dataset'
  providerId: string
  sessionId: number
  /** The provider's handle for the dataset (`VoteDataset.key`). */
  key: string
  hash: string
}

export type BillMessage = {
  kind?: undefined
  billId: number
  forceMetadata?: boolean
  forceAI?: boolean  // propagate to tenant notification so tenant re-runs AI even if text unchanged
  interactive?: boolean  // relay from tenant promote-bill request; false = background
  skipFetch?: boolean  // skip LegiScan getBill API call; use existing DB data + download text from state_link
  /**
   * Re-download bill text even when an r2_key is already stored. Both download
   * guards otherwise skip a document that has text, which makes a corrective
   * re-fetch a no-op. Used by /admin/refetch-fragment-texts.
   */
  forceTextRefetch?: boolean
  /**
   * Recheck the bill's calendar instead of ingesting it: a sync pass listed
   * the bill with this change hash, the hash of the pull its missing calendar
   * entries were missing from (lib/billCalendar.ts). Calls no provider.
   */
  calendarRecheck?: string
  /**
   * The provider whose sync queued this, for a bill waiting for its first
   * ingest since a cutover moved it there (cron/sync.ts). The ingest is
   * skipped, with no provider call, once the bill has moved on to another
   * provider: after an undo, the previous provider's own sync queues it on
   * its own queue, rather than this message spending its calls from this one.
   */
  queuedBy?: string
  /**
   * As `queuedBy`, for an untracked bill queued only for that first ingest.
   * It is also skipped once the bill has had that ingest, so a pass that
   * queues the bill again while an earlier message waits costs nothing. A
   * tracked bill's message never is: it may also be for a new keyword match,
   * which instances must hear of.
   */
  firstIngestFor?: string
  /**
   * The first full ingest of a bill a provider's ingestAll queued before it
   * had one (cron/sync.ts). While the bill still has had none, the ingest
   * stores its data and sends it with no changes, as a new bill's is: its
   * backlog of actions, documents, and past hearings isn't news.
   */
  firstFullIngest?: boolean
  /**
   * The instances this message brings a new keyword match to, by tenant id,
   * and where each match came from (MatchProvenance). Each instance's
   * notification carries its own. An instance missing here gets none, which
   * it treats as bulk.
   */
  matchProvenance?: Record<string, MatchProvenance>
}

/**
 * Where a keyword match came from. Routine: the regular sync linked a bill
 * central had just found, for an instance that already followed the bill's
 * state (bills of this or an earlier session). Bulk: anything else that
 * matches bills in bulk (a session seed, a keyword re-run, an instance's first
 * pass over a state it never followed, a cutover's pass, an operator import). Only routine matches reach an instance's feed and digest, and a
 * match with no declaration is bulk.
 */
export type MatchProvenance = 'routine' | 'bulk'

/**
 * A bill's calendar, as instances receive it with a notification. `events` is
 * every entry that isn't cancelled, and an instance cancels any entry of the
 * bill's that isn't in it. `changes` names what changed since the last pull.
 * Each entry's `identityKey` never changes (lib/billCalendar.ts), and
 * instances build its calendar UID from it.
 */
export type CalendarBlock = {
  events: {
    identityKey: string
    kind: CalendarKind
    date: string | null
    time: string | null
    location: string | null
    description: string | null
    eventHash: string | null
    /**
     * The UID of the body event covering the entry (lib/bodyEvents.ts), which
     * instances show in its place, or null. Only from a provider that
     * publishes the legislature's own calendar.
     */
    coveredBy?: string | null
  }[]
  changes: {
    changeType: 'hearing_added' | 'hearing_changed' | 'hearing_cancelled'
    identityKey: string
    kind: CalendarKind
    date: string | null
    time: string | null
    location: string | null
    description: string | null
    eventHash: string | null
  }[]
}

export type NotificationMessage = {
  tenantId: string
  billId: string   // the bill handle, "bill:{bill_id}" (toHandle in lib/billHandle), sent as "legiscan:{bill_id}" to an instance that doesn't read neutral handles (lib/tenantDelivery.ts)
  forceMetadata?: boolean
  forceAI?: boolean
  interactive?: true     // only set when true; omitted for all background paths
  stubOnly?: boolean // Update stub metadata only; skip full bill fetch and AI
  metadataOnly?: boolean // Refresh metadata from central; skip text fetch + AI.
  matchType?: 'keyword' | 'manual' | null
  /** Set when this message brings the instance a new keyword match (BillMessage.matchProvenance). */
  matchProvenance?: MatchProvenance
  changes?: {
    changeType: string
    oldValue: string | null
    newValue: string | null
    detail: string | null
    detectedAt: string
  }[]
  calendar?: CalendarBlock
}
