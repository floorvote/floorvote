import { inArray } from 'drizzle-orm'
import { associationConfig } from '../db/schema'
import { computeEngagementStats } from './engagementStats'
import type { AppDb } from '../types'

export type EngagementSnapshot = {
  computedAt: string
  metrics: Awaited<ReturnType<typeof computeEngagementStats>>
  resend: { monthlyUsed: number; dailyUsed: number; usedAt: string; last429At: string }
}

export async function computeEngagementSnapshot(db: AppDb): Promise<EngagementSnapshot> {
  const metrics = await computeEngagementStats(db)
  const cfgRows = await db.select().from(associationConfig)
    .where(inArray(associationConfig.key, ['resend_monthly_used', 'resend_daily_used', 'resend_used_at', 'resend_last_429_at']))
    .all()
  const cfg = new Map(cfgRows.map(r => [r.key, r.value]))
  const numOr0 = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : 0)
  const resend = {
    monthlyUsed: numOr0(cfg.get('resend_monthly_used')),
    dailyUsed: numOr0(cfg.get('resend_daily_used')),
    usedAt: cfg.get('resend_used_at') ?? '',
    last429At: cfg.get('resend_last_429_at') ?? '',
  }
  const now = new Date().toISOString() // ts-write-ok: response payload computedAt, never a DB column
  return { computedAt: now, metrics, resend }
}
