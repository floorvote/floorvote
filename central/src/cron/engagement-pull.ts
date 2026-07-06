import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema-legiscan'
import type { LsEnv } from '../types-legiscan'
import { getSetting, setSetting } from '../lib/settings'
import { snapshotResendDaily } from '../lib/resendUsage'
import { nowDb } from '../lib/dbTime'
import { resolveTenantRpc, type EngagementSnapshotData } from '../lib/tenantRpc'
import { sendOpsAlert, escHtml } from '../lib/jobAlert'
import { PRODUCT_NAME } from '../../../shared/brand'

type DB = ReturnType<typeof drizzle<typeof schema>>

const DEFAULT_LATENCY_THRESHOLD_MS = 3000

function latencyThresholdMs(env: LsEnv): number {
  const n = Number(env.D_LATENCY_THRESHOLD_MS ?? DEFAULT_LATENCY_THRESHOLD_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LATENCY_THRESHOLD_MS
}

const METRIC_KEYS = [
  'total_members', 'active_members_7d', 'active_members_30d',
  'votes_cast', 'comments_written', 'comment_reactions',
  'positions_set', 'notes_created', 'custom_field_values',
  'bills_with_engagement', 'roles_defined', 'custom_fields_defined',
  'bills_ai_processed',
] as const
type MetricKey = (typeof METRIC_KEYS)[number]

type ResendBlock = { monthlyUsed?: number; dailyUsed?: number; usedAt?: string; last429At?: string }

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function snapshotToMetrics(data: EngagementSnapshotData): { metrics: Record<MetricKey, number>; resend: ResendBlock | null } {
  const out = {} as Record<MetricKey, number>
  for (const k of METRIC_KEYS) {
    const v = data.metrics?.[k]
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  return { metrics: out, resend: data.resend ?? null }
}

async function getTenantSnapshot(env: LsEnv, tenantId: string, apiUrl: string): Promise<{ metrics: Record<MetricKey, number>; resend: ResendBlock | null }> {
  const rpc = resolveTenantRpc(env, tenantId)
  if (rpc) return snapshotToMetrics(await rpc.engagementStats())
  // Fallback: HTTP + shared secret (local dev, un-bound tenants, self-host)
  const url = `${apiUrl.replace(/\/$/, '')}/api/internal/engagement-stats`
  const res = await fetch(url, {
    headers: { 'x-admin-secret': env.ADMIN_SECRET ?? '' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`tenant snapshot ${url} returned ${res.status}`)
  const body = await res.json() as { data: EngagementSnapshotData }
  return snapshotToMetrics(body.data)
}

async function upsertRow(
  db: DB,
  tenantId: string,
  statDate: string,
  metrics: Record<MetricKey, number>,
  probe: { latencyMs: number; ok: boolean },
): Promise<typeof schema.tenantStats.$inferSelect> {
  const values = {
    tenantId,
    statDate,
    probeLatencyMs:      probe.latencyMs,
    probeOk:             probe.ok ? 1 : 0,
    totalMembers:        metrics.total_members,
    activeMembers7d:     metrics.active_members_7d,
    activeMembers30d:    metrics.active_members_30d,
    votesCast:           metrics.votes_cast,
    commentsWritten:     metrics.comments_written,
    commentReactions:    metrics.comment_reactions,
    positionsSet:        metrics.positions_set,
    notesCreated:        metrics.notes_created,
    customFieldValues:   metrics.custom_field_values,
    billsWithEngagement: metrics.bills_with_engagement,
    rolesDefined:        metrics.roles_defined,
    customFieldsDefined: metrics.custom_fields_defined,
    billsAiProcessed:    metrics.bills_ai_processed,
    pulledAt:            nowDb(),
  }
  await db.insert(schema.tenantStats).values(values)
    .onConflictDoUpdate({
      target: [schema.tenantStats.tenantId, schema.tenantStats.statDate],
      set: values,
    })
  const row = await db.select().from(schema.tenantStats)
    .where(and(eq(schema.tenantStats.tenantId, tenantId), eq(schema.tenantStats.statDate, statDate)))
    .get()
  return row!
}

async function mergeResendReading(db: DB, resend: ResendBlock | null): Promise<void> {
  if (!resend || !resend.usedAt) return
  const prevAt = await getSetting(db, 'resend_used_at', '')
  if (prevAt && prevAt >= resend.usedAt) {
    // Older-or-equal reading; still surface a more recent 429 if present.
    if (resend.last429At) {
      const prev429 = await getSetting(db, 'resend_last_429_at', '')
      if (resend.last429At > prev429) await setSetting(db, 'resend_last_429_at', resend.last429At)
    }
    return
  }
  if (typeof resend.monthlyUsed === 'number') await setSetting(db, 'resend_monthly_used', String(resend.monthlyUsed))
  if (typeof resend.dailyUsed === 'number') await setSetting(db, 'resend_daily_used', String(resend.dailyUsed))
  await setSetting(db, 'resend_used_at', resend.usedAt)
  if (typeof resend.monthlyUsed === 'number') {
    try { await snapshotResendDaily(db, resend.monthlyUsed, typeof resend.dailyUsed === 'number' ? resend.dailyUsed : 0) }
    catch (e) { console.error('[resend-snapshot]', e) }
  }
  if (resend.last429At) await setSetting(db, 'resend_last_429_at', resend.last429At)
}

export async function pullEngagementStatsForTenant(
  env: LsEnv,
  db: DB,
  tenantId: string,
): Promise<typeof schema.tenantStats.$inferSelect> {
  const tenant = await db.select().from(schema.tenants).where(eq(schema.tenants.tenantId, tenantId)).get()
  if (!tenant) throw new Error(`tenant ${tenantId} not found`)
  if (!tenant.apiUrl) throw new Error(`tenant ${tenantId} has no apiUrl`)
  const t0 = Date.now()
  const { metrics, resend } = await getTenantSnapshot(env, tenantId, tenant.apiUrl)
  const latencyMs = Date.now() - t0
  const row = await upsertRow(db, tenantId, todayUtcDate(), metrics, { latencyMs, ok: true })
  await mergeResendReading(db, resend)
  await db.update(schema.tenants)
    .set({ lastSeenAt: nowDb() })
    .where(eq(schema.tenants.tenantId, tenantId))
  return row
}

type ProbeResult = {
  tenant: typeof schema.tenants.$inferSelect
  latencyMs: number
  ok: boolean
  error?: string
} & ({ ok: true; metrics: Record<MetricKey, number>; resend: ResendBlock | null } | { ok: false })

export async function pullEngagementStats(env: LsEnv, db: DB): Promise<void> {
  const tenants = await db.select().from(schema.tenants).all()
  const date = todayUtcDate()

  // Fetch every tenant's snapshot in parallel, timing each round trip. Network
  // is the slow part (each call can take up to 30s); done sequentially this
  // scales O(tenants) in wall-clock and blows the cron budget well before ~50
  // tenants. A failed call still yields a ProbeResult (ok=false) so we can
  // record probe_ok=0 and alert.
  const results = await Promise.all(tenants.map(async (t): Promise<ProbeResult | null> => {
    if (!t.apiUrl) {
      console.warn('engagement pull: skipping', t.tenantId, '- no apiUrl')
      return null
    }
    const t0 = Date.now()
    try {
      const { metrics, resend } = await getTenantSnapshot(env, t.tenantId, t.apiUrl)
      return { tenant: t, latencyMs: Date.now() - t0, ok: true, metrics, resend }
    } catch (err: any) {
      const error = err?.message ?? String(err)
      console.error('engagement pull failed', { tenantId: t.tenantId, error })
      return { tenant: t, latencyMs: Date.now() - t0, ok: false, error }
    }
  }))

  // Apply DB writes sequentially in tenant order. mergeResendReading does a
  // read-modify-write keyed on "newest reading wins", so ordering must be
  // deterministic — keep it serial rather than racing concurrent writers.
  for (const r of results) {
    if (!r) continue
    if (r.ok) {
      await upsertRow(db, r.tenant.tenantId, date, r.metrics, { latencyMs: r.latencyMs, ok: true })
      await mergeResendReading(db, r.resend)
      await db.update(schema.tenants)
        .set({ lastSeenAt: nowDb() })
        .where(eq(schema.tenants.tenantId, r.tenant.tenantId))
    } else {
      // Record the failed probe on the tenant's EXISTING daily row only —
      // update probe_latency_ms + probe_ok=0, preserving the engagement metrics
      // (and last_seen_at) the last successful pull wrote. We deliberately do NOT
      // INSERT a row when none exists for today: a fresh row would carry the
      // schema's NOT NULL DEFAULT 0 metric columns, which the dashboard time
      // series renders as a real engagement drop-to-zero — a false data point
      // landing exactly during a tenant failure. No row → leave a gap instead.
      // A drizzle .update() matching no rows is a safe no-op, giving us the
      // "skip when no row exists today" behavior for free. The end-of-loop
      // sendOpsAlert still fires off the in-memory `flagged` results, so the
      // failure is surfaced regardless of whether a row was written.
      await db.update(schema.tenantStats)
        .set({ probeLatencyMs: r.latencyMs, probeOk: 0 })
        .where(and(
          eq(schema.tenantStats.tenantId, r.tenant.tenantId),
          eq(schema.tenantStats.statDate, date),
        ))
    }
  }

  // After the loop, alert on any tenant that failed OR was slow. One summary
  // email covers them all — early warning of a degrading tenant.
  const threshold = latencyThresholdMs(env)
  const flagged = results.filter((r): r is ProbeResult =>
    r != null && (!r.ok || r.latencyMs > threshold))
  if (flagged.length > 0) {
    await sendSlowTenantAlert(env, flagged, threshold)
  }
}

async function sendSlowTenantAlert(env: LsEnv, flagged: ProbeResult[], threshold: number): Promise<void> {
  const lines = flagged.map((r) => {
    const status = r.ok ? `slow (${r.latencyMs}ms)` : `FAILED${r.error ? ` — ${r.error}` : ''}`
    return `${r.tenant.tenantId} (${r.tenant.name ?? '?'}): ${status}, latency ${r.latencyMs}ms, ok=${r.ok ? 1 : 0}`
  })
  const subject = `[${PRODUCT_NAME}] engagement pull: ${flagged.length} tenant(s) slow or failing`
  const text =
    `The daily engagement pull flagged ${flagged.length} tenant(s) ` +
    `(threshold ${threshold}ms):\n\n` +
    lines.map((l) => `• ${l}`).join('\n') + '\n'
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">
        The daily engagement pull flagged <strong>${flagged.length}</strong> tenant(s)
        (latency threshold ${threshold}ms):
      </p>
      <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.7; color: #0f172a;">
        ${lines.map((l) => `<li>${escHtml(l)}</li>`).join('')}
      </ul>
    </div>
  `
  await sendOpsAlert(env, { subject, text, html })
}

export function shouldRunEngagementPull(now: Date): boolean {
  return now.getUTCHours() === 6
}
