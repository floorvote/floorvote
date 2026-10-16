import type { Env } from '../types'

export type EngagementSnapshotData = {
  computedAt: string
  metrics: Record<string, number>
  excluded?: Record<string, number>  // user-attributable metrics recomputed with internal domains excluded (see adoption exclusion)
  resend?: { monthlyUsed?: number; dailyUsed?: number; usedAt?: string; last429At?: string }
}

/** How an instance's claim links resolved (#573): counts only, mirroring the instance's `ClaimSourceCounts`. */
export type ClaimSourceCountsData = {
  analyses: { withClaimSources: number; emptyList: number; noList: number }
  items: { exact: number; normalized: number; fuzzy: number; anchored: number; ungrounded: number; unverified: number; total: number }
  cutOffRetries: number
}

/** RPC surface exposed by the tenant's CentralApi WorkerEntrypoint. */
export interface TenantRpc {
  engagementStats(excludeDomains?: string[]): Promise<EngagementSnapshotData>
  forceRegister(): Promise<boolean>
  demoReset(): Promise<{ ok: boolean; billsSeeded: boolean }>
  runDigestNow(): Promise<{ ok: boolean }>
  refreshMetadata(): Promise<{ queued: number }>
  sendSampleEmail(to: string, type: string): Promise<{ ok: boolean; provider?: string; error?: string }>
  deliveryProbe(): Promise<{ probe: { nonce: string; billId: string; receivedAt: string; readStatus: number } | null }>
  verifyAi(billId: string): Promise<
    | { status: 'ok'; billNumber: string; tags: number; relevanceScore: number; usedFullText: boolean }
    | { status: 'skipped'; reason: string }
  >
  claimSourceCounts(): Promise<ClaimSourceCountsData>
  unknownLoginAttempts(): Promise<Array<{ id: string; email: string; ipCountry: string | null; userAgent: string | null; createdAt: string }>>
}

/** Resolve the per-tenant service binding, or null if this tenant isn't bound. */
export function resolveTenantRpc(env: Env, tenantId: string): TenantRpc | null {
  const key = `TENANT_${tenantId.toUpperCase().replaceAll('-', '_')}`
  const binding = env[key]
  return binding ? (binding as unknown as TenantRpc) : null
}
