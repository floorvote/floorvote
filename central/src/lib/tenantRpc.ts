import type { LsEnv } from '../types-legiscan'

export type EngagementSnapshotData = {
  computedAt: string
  metrics: Record<string, number>
  resend?: { monthlyUsed?: number; dailyUsed?: number; usedAt?: string; last429At?: string }
}

/** RPC surface exposed by the tenant's CentralApi WorkerEntrypoint. */
export interface TenantRpc {
  engagementStats(): Promise<EngagementSnapshotData>
  forceRegister(): Promise<boolean>
  demoReset(): Promise<{ ok: boolean; billsSeeded: boolean }>
  runDigestNow(): Promise<{ ok: boolean }>
  refreshMetadata(): Promise<{ queued: number }>
  sendSampleEmail(to: string, type: string): Promise<{ ok: boolean; provider?: string; error?: string }>
  unknownLoginAttempts(): Promise<Array<{ id: string; email: string; ipCountry: string | null; userAgent: string | null; createdAt: string }>>
}

/** Resolve the per-tenant service binding, or null if this tenant isn't bound. */
export function resolveTenantRpc(env: LsEnv, tenantId: string): TenantRpc | null {
  const key = `TENANT_${tenantId.toUpperCase().replaceAll('-', '_')}`
  const binding = env[key]
  return binding ? (binding as unknown as TenantRpc) : null
}
