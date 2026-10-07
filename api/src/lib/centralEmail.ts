import type { Env } from '../types'

/** One email's delivery outcome as central reports it (Cloudflare Email Sending). */
export type DeliveryStatus = { status: string; isSpam: boolean; errorCause?: string; datetime?: string }

/** Whether the provider drops mail to an address; `suppressed: null` means the lookup couldn't tell. */
export type SuppressionStatus = { suppressed: boolean | null; reason?: string; createdAt?: string }

/** The email RPC methods central exposes on the CENTRAL service binding. */
export type CentralEmail = {
  emailSuppression?: (email: string) => Promise<SuppressionStatus>
  /** Many addresses with one fetch of the list, keyed by lowercased, trimmed address. */
  emailSuppressionMany?: (emails: string[]) => Promise<Record<string, SuppressionStatus>>
  emailDeliveryStatus?: (messageIds: string[], since: string) => Promise<Record<string, DeliveryStatus>>
}

/**
 * The CENTRAL binding's email methods, typed. `Env` types the binding as a
 * plain Fetcher, so this is the one place that widens it. Any method can
 * be missing (no binding, or an older central), and callers treat that as
 * "can't tell".
 */
export function centralEmail(env: Pick<Env, 'CENTRAL'>): CentralEmail {
  return (env.CENTRAL as CentralEmail | undefined) ?? {}
}
