import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './db/schema'

export type Env = {
  DB: D1Database
  BILLS_BUCKET: R2Bucket
  INGESTOR_QUEUE: Queue
  LEGISCAN_API_KEY: string
  OPENSTATES_API_KEY: string
  ADMIN_SECRET: string
  OPERATOR_NAME: string
  BILL_PROVIDER: 'openstates' | 'legiscan'
  // Optional — used by jobAlert (scheduled-job failure email) on the self-hosting path.
  RESEND_API_KEY?: string
  EMAIL?: import('./lib/email').CloudflareEmailBinding
  EMAIL_PROVIDER?: string
  ALERT_EMAILS?: string  // recipients of ops/cron-failure alerts
  CF_ACCOUNT_ID?: string  // Cloudflare account id
  CF_EMAIL_TOKEN?: string  // CF API token (Email Sending: Read) for suppression-list checks
  CF_ANALYTICS_TOKEN?: string  // CF API token (Account Analytics: Read + Zone Analytics: Read) for anomaly watch + email delivery
  CF_FLOORVOTE_ZONE_ID?: string  // Cloudflare zone id for emailSendingAdaptive GraphQL dataset
}

export type CentralDb = DrizzleD1Database<typeof schema>

export type IngestorQueueMessage = {
  billId: string
}

export type NotificationQueueMessage = {
  tenantId: string
  billId: string
  forceReprocess?: boolean
}
