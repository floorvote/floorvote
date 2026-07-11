import { WorkerEntrypoint } from 'cloudflare:workers'
import { getDb } from './db/client'
import { authEvents } from './db/schema'
import { eq, desc } from 'drizzle-orm'
import { computeEngagementSnapshot, type EngagementSnapshot } from './lib/engagementSnapshot'
import { refreshMetadata } from './lib/refreshMetadata'
import { demoResetAndSeed } from './lib/demoResetAndSeed'
import { registerWithCentral } from './cron/sync'
import { runDigest } from './lib/digest'
import { sendSampleEmail, isSampleEmailType, type SampleSendResult } from './lib/sampleEmails'
import type { Env } from './types'

/**
 * Named entrypoint reachable ONLY via same-account service bindings (never the
 * public internet). Central binds to this with `entrypoint = "CentralApi"`.
 * Arrival here IS the authentication — central->tenant and operator->tenant
 * calls route through here instead of the secret-gated HTTP /api/internal/*
 * endpoints, so the tenant holds no shared secret in production.
 */
export class CentralApi extends WorkerEntrypoint<Env> {
  async engagementStats(excludeDomains?: string[]): Promise<EngagementSnapshot> {
    return computeEngagementSnapshot(getDb(this.env.DB), excludeDomains)
  }

  async forceRegister(): Promise<boolean> {
    return registerWithCentral(this.env, getDb(this.env.DB))
  }

  async demoReset(): Promise<{ ok: boolean; billsSeeded: boolean }> {
    return demoResetAndSeed(this.env)
  }

  async runDigestNow(): Promise<{ ok: boolean; recipients: number; sent: number; failed: number }> {
    return runDigest(this.env, getDb(this.env.DB), { ignoreSchedule: true })
  }

  async refreshMetadata(): Promise<{ queued: number }> {
    return refreshMetadata(this.env, getDb(this.env.DB))
  }

  async sendSampleEmail(to: string, type: string): Promise<SampleSendResult> {
    if (!isSampleEmailType(type)) return { ok: false, error: 'invalid type' }
    return sendSampleEmail(this.env, getDb(this.env.DB), to, type)
  }

  async unknownLoginAttempts(): Promise<Array<{ id: string; email: string; ipCountry: string | null; userAgent: string | null; createdAt: string }>> {
    const db = getDb(this.env.DB)
    return db
      .select({
        id: authEvents.id,
        email: authEvents.email,
        ipCountry: authEvents.ipCountry,
        userAgent: authEvents.userAgent,
        createdAt: authEvents.createdAt,
      })
      .from(authEvents)
      .where(eq(authEvents.event, 'link_requested_unknown'))
      .orderBy(desc(authEvents.createdAt))
      .limit(50)
      .all()
  }
}
