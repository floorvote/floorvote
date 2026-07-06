import type { LsEnv } from '../types-legiscan'
import { listTrackedD1Dbs, fetchDailyRowsRead, type DailyRowsRead } from './d1Analytics'
import { sendOpsAlert } from './jobAlert'
import { PRODUCT_NAME } from '../../../shared/brand'

type WatchEnv = Pick<
  LsEnv,
  | 'CF_ANALYTICS_TOKEN'
  | 'CF_ACCOUNT_ID'
  | 'D1_ANOMALY_FACTOR'
  | 'D1_ANOMALY_FLOOR'
  | 'RESEND_API_KEY'
  | 'EMAIL_PROVIDER'
  | 'EMAIL'
  | 'ALERT_EMAILS'
>

/** Need at least this many days (incl. latest) before a baseline is meaningful. */
export const MIN_DAYS = 4
/** Calendar days of history to pull (latest + 7 days of baseline). */
const WINDOW_DAYS = 8

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** Per-database verdict — returned by the dry-run trigger and used to build alerts. */
export type DbAnalysis = {
  name: string
  id: string
  days: number
  latest: number
  baseline: number
  threshold: number
  multiple: number
  flagged: boolean
  insufficientData: boolean
}

export type AnomalyWatchOptions = {
  /** Override the spike multiple (default env D1_ANOMALY_FACTOR or 5). */
  factor?: number
  /** Override the rows/day floor (default env D1_ANOMALY_FLOOR or 50M). */
  floor?: number
  /** Send the ops-alert email when something is flagged. Default true; false = dry-run. */
  send?: boolean
}

export type AnomalyWatchResult = {
  ran: boolean
  reason?: string
  factor: number
  floor: number
  analyzed: DbAnalysis[]
  flagged: DbAnalysis[]
  emailSent: boolean
}

/**
 * Pure spike test for one database's daily rows-read series (date-ASC).
 * Flags when the latest day exceeds max(factor × baseline-median, floor).
 */
export function analyzeSeries(
  name: string,
  id: string,
  series: DailyRowsRead[],
  factor: number,
  floor: number,
): DbAnalysis {
  const days = series.length
  if (days < MIN_DAYS) {
    return {
      name, id, days,
      latest: days > 0 ? series[days - 1].rowsRead : 0,
      baseline: 0, threshold: 0, multiple: 0,
      flagged: false, insufficientData: true,
    }
  }
  const latest = series[days - 1].rowsRead
  const baseline = median(series.slice(0, -1).map((p) => p.rowsRead))
  const threshold = Math.max(factor * baseline, floor)
  const flagged = latest > threshold
  const multiple = baseline > 0 ? latest / baseline : Infinity
  return { name, id, days, latest, baseline, threshold, multiple, flagged, insufficientData: false }
}

/**
 * Daily watch: pull each tracked D1 database's rowsRead from Cloudflare analytics
 * and email an ops alert when one spikes far above its recent norm — the signal
 * that would have caught the June 2026 demo crawler incident (10M → 237M/day).
 *
 * Returns a structured result so the manual /admin/anomaly-watch trigger can
 * surface the per-DB numbers (and run dry, with `send: false`).
 *
 * No-op when CF analytics credentials are unset.
 */
export async function runAnomalyWatch(
  env: WatchEnv,
  opts: AnomalyWatchOptions = {},
): Promise<AnomalyWatchResult> {
  const FACTOR = opts.factor ?? Number(env.D1_ANOMALY_FACTOR ?? 5)
  const FLOOR = opts.floor ?? Number(env.D1_ANOMALY_FLOOR ?? 50_000_000)
  const send = opts.send !== false
  const base: AnomalyWatchResult = {
    ran: false, factor: FACTOR, floor: FLOOR, analyzed: [], flagged: [], emailSent: false,
  }

  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) {
    console.warn('[d1-anomaly-watch] skipped — CF_ANALYTICS_TOKEN / CF_ACCOUNT_ID unset')
    return { ...base, reason: 'CF_ANALYTICS_TOKEN / CF_ACCOUNT_ID unset' }
  }

  const dbs = await listTrackedD1Dbs(env)
  if (dbs.length === 0) {
    console.warn('[d1-anomaly-watch] no tracked D1 databases found')
    return { ...base, ran: true, reason: 'no tracked D1 databases found' }
  }

  const now = new Date()
  const until = ymd(now)
  const since = ymd(new Date(now.getTime() - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000))

  const byDb = await fetchDailyRowsRead(env, dbs.map((d) => d.id), since, until)

  const analyzed = dbs.map((db) => analyzeSeries(db.name, db.id, byDb[db.id] ?? [], FACTOR, FLOOR))
  const flags = analyzed.filter((a) => a.flagged)

  if (flags.length === 0 || !send) {
    return { ...base, ran: true, analyzed, flagged: flags, emailSent: false }
  }

  const names = flags.map((f) => f.name).join(', ')
  const subject = `[${PRODUCT_NAME}] D1 read spike: ${names}`

  const lines = flags.map(
    (f) =>
      `• ${f.name}: latest ${fmt(f.latest)} rows-read vs baseline ${fmt(f.baseline)} ` +
      `(${f.multiple === Infinity ? '∞' : f.multiple.toFixed(1)}×)`,
  )
  const text =
    `Daily D1 rows-read anomaly watch flagged ${flags.length} database${flags.length === 1 ? '' : 's'}:\n\n` +
    lines.join('\n') +
    `\n\nThreshold: latest > max(${FACTOR}× baseline, ${fmt(FLOOR)}). ` +
    `Baseline = median of the prior ${WINDOW_DAYS - 1} days.`

  const htmlRows = flags
    .map(
      (f) =>
        `<li style="margin: 0 0 8px;"><strong>${escHtml(f.name)}</strong>: latest ` +
        `${fmt(f.latest)} rows-read vs baseline ${fmt(f.baseline)} ` +
        `(${f.multiple === Infinity ? '∞' : f.multiple.toFixed(1)}×)</li>`,
    )
    .join('')
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">
        Daily D1 rows-read anomaly watch flagged <strong>${flags.length}</strong> database${flags.length === 1 ? '' : 's'}.
      </p>
      <ul style="margin: 0 0 16px; padding-left: 20px; font-size: 14px; line-height: 1.5; color: #0f172a;">${htmlRows}</ul>
      <p style="margin: 0; font-size: 12px; color: #94a3b8;">
        Threshold: latest &gt; max(${FACTOR}× baseline, ${fmt(FLOOR)}). Baseline = median of the prior ${WINDOW_DAYS - 1} days.
      </p>
    </div>
  `

  await sendOpsAlert(env, { subject, text, html })
  return { ...base, ran: true, analyzed, flagged: flags, emailSent: true }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
