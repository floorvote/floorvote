import { and, eq, gte } from 'drizzle-orm'
import type { Env, AppDb } from '../types'
import { emailSendStats, emailAlertState } from '../db/schema'
import { senderFor, activeProvider, otherProvider, type ProviderName } from './email'
import { decideEmailHealth, windowStartHour, OK_STATE, type HealthDecision, type HealthState, type HourStat } from './emailHealth'
import { toDbTs } from './dbTime'
import { parseEmailList } from '../../../shared/operator'
import { PRODUCT_NAME } from '../../../shared/brand'

/**
 * Hourly: decide whether the primary email provider is failing, and tell
 * ALERT_EMAILS through the OTHER provider first (the outage-alert purpose's
 * order). reportJobFailure can't do this job: it tries the active provider
 * first, so during the 2026-09-23 outage its alert would have gone to the
 * failing one before the healthy one.
 */
export async function runEmailHealth(env: Env, db: AppDb, now: Date = new Date()): Promise<HealthDecision> {
  const primary = activeProvider(env)
  const alternate = otherProvider(env, primary)
  const windowStart = windowStartHour(now)

  const rows: HourStat[] = await db.select().from(emailSendStats)
    .where(and(eq(emailSendStats.provider, primary), gte(emailSendStats.hour, windowStart))).all()
  const stored = await db.select().from(emailAlertState).where(eq(emailAlertState.provider, primary)).get()
  const state: HealthState = stored
    ? { status: stored.status, failingSince: stored.failingSince, lastAlertedAt: stored.lastAlertedAt, recoveredAt: stored.recoveredAt }
    : OK_STATE

  const decision = decideEmailHealth(now, rows, state)
  if (decision === 'none') return decision

  const ts = toDbTs(now)
  const failingSince = decision === 'trip' ? ts : state.failingSince
  let rescued: number | null = null
  if (alternate) {
    const alt = await db.select().from(emailSendStats)
      .where(and(eq(emailSendStats.provider, alternate), gte(emailSendStats.hour, windowStart))).all()
    rescued = alt.reduce((n, r) => n + r.sent, 0)
  }

  // A remind whose trip alert never got through reads as a first alert, not "still failing".
  const wording = decision === 'remind' && !state.lastAlertedAt ? 'trip' : decision
  const alerted = await sendHealthAlert(env, { decision: wording, primary, alternate, rows, rescued, failingSince })

  const next = decision === 'recover'
    ? { status: 'ok' as const, failingSince: null, recoveredAt: ts }
    : { status: 'failing' as const, failingSince, recoveredAt: state.recoveredAt }
  const lastAlertedAt = alerted ? ts : state.lastAlertedAt
  await db.insert(emailAlertState).values({ provider: primary, ...next, lastAlertedAt })
    .onConflictDoUpdate({ target: emailAlertState.provider, set: { ...next, lastAlertedAt } })
  return decision
}

type AlertInput = {
  decision: Exclude<HealthDecision, 'none'>
  primary: ProviderName
  alternate: ProviderName | null
  rows: HourStat[]
  rescued: number | null
  failingSince: string | null
}

/** Returns whether the alert was sent. Never throws. */
async function sendHealthAlert(env: Env, a: AlertInput): Promise<boolean> {
  const recipients = parseEmailList(env.ALERT_EMAILS)
  if (recipients.length === 0) {
    console.error(`[email-health] ${a.primary} ${a.decision} but ALERT_EMAILS is unset — no alert sent`)
    return false
  }
  if (!a.alternate) {
    console.error(`[email-health] no independent alert path: ${a.primary} is the only configured provider, so this alert may fail with it`)
  }
  const { subject, text, html } = renderHealthAlert(env, a)
  try {
    // The outage-alert purpose decides the rest: the healthy provider first,
    // then the failing one (a stale RESEND_API_KEY or an EMAIL_FROM not verified
    // on Resend must not swallow the alert), and never counted (operator mail
    // keeps arriving during a verified-only outage, so counting it as a primary
    // success could fake a recovery), so no db.
    const r = await senderFor(env).send({ purpose: 'outage-alert', to: recipients, subject, html, text })
    if (!r.ok) console.error(`[email-health] alert send failed (${r.provider ?? 'no provider'}): ${r.error}`)
    return r.ok
  } catch (err) {
    console.error('[email-health] alert send threw', err)
    return false
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderHealthAlert(env: Pick<Env, 'APP_URL'>, a: AlertInput): { subject: string; text: string; html: string } {
  const host = (() => { try { return new URL(env.APP_URL).host } catch { return env.APP_URL } })()
  const sent = a.rows.reduce((n, r) => n + r.sent, 0)
  const failed = a.rows.reduce((n, r) => n + r.failed, 0)
  const suppressed = a.rows.reduce((n, r) => n + r.suppressed, 0)
  const lastError = [...a.rows].sort((x, y) => (x.hour < y.hour ? 1 : -1)).find(r => r.lastError)?.lastError ?? null

  const subject = {
    trip: `[${PRODUCT_NAME}] Email sending is failing on ${host} (${a.primary})`,
    remind: `[${PRODUCT_NAME}] Email sending is still failing on ${host} (${a.primary})`,
    recover: `[${PRODUCT_NAME}] Email sending recovered on ${host} (${a.primary})`,
  }[a.decision]

  const lead = {
    trip: `${a.primary} started failing to send email for ${host}.`,
    remind: `${a.primary} is still failing to send email for ${host}${a.failingSince ? `, since ${a.failingSince} UTC` : ''}.`,
    recover: `${a.primary} is sending email for ${host} again.`,
  }[a.decision]

  const rescue = a.alternate
    ? `Login and invite links fall back to ${a.alternate}: ${a.rescued ?? 0} sent through ${a.alternate} in the last 24 hours.`
    : `No fallback provider is configured, so login and invite links are failing too.`

  const lines = [
    lead,
    '',
    `Last 24 hours through ${a.primary}: ${sent} sent, ${failed} failed, ${suppressed} suppressed.`,
    ...(lastError ? [`Last error: ${lastError}`] : []),
    '',
    ...(a.decision === 'recover' ? [] : [rescue, 'Digests and week-ahead mail do not fall back and are not being delivered.']),
    '',
    `This alert was sent through ${a.alternate ?? a.primary}.`,
  ]
  const text = lines.join('\n')
  const html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a; font-size: 15px; line-height: 1.6;">`
    + lines.map(l => (l ? `<p style="margin: 0 0 12px;">${escHtml(l)}</p>` : '')).join('')
    + `</div>`
  return { subject, text, html }
}
