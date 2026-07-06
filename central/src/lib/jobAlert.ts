import type { LsEnv } from '../types-legiscan'
import { sendEmail } from './email'
import { PRODUCT_NAME } from '../../../shared/brand'

// Structural subset of the env that jobAlert needs. Both the LegiScan `LsEnv`
// and the OpenStates `Env` satisfy it (the OS env carries these as optional),
// so the same helper wraps scheduled jobs in either central entry file.
type AlertEnv = Pick<LsEnv, 'RESEND_API_KEY' | 'EMAIL_PROVIDER' | 'EMAIL' | 'ALERT_EMAILS'>

/**
 * Scheduled jobs run via `ctx.waitUntil(promise)`; a rejected promise vanishes
 * silently. `runJob` wraps a job so any throw is logged AND emailed to the
 * operator, then swallowed so `ctx.waitUntil` always observes success.
 */
export async function runJob(env: AlertEnv, name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(`[job:${name}] failed`, error)
    await reportJobFailure(env, { job: name, error })
  }
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The configured ops-alert recipients (`env.ALERT_EMAILS`, comma-separated).
 * ALERT_EMAILS is intentionally separate from SUPERADMIN_EMAILS: superadmins have
 * full domain access, which is not the same set as "who should receive ops alerts."
 */
function alertRecipients(env: AlertEnv): string[] {
  return (env.ALERT_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Best-effort ops alert: send `{ subject, text, html }` to every `alertRecipients`
 * address via `sendEmail`. Never throws; no-ops (just logs) when no recipients.
 */
export async function sendOpsAlert(env: AlertEnv, msg: { subject: string; text: string; html: string }): Promise<void> {
  const recipients = alertRecipients(env)
  if (recipients.length === 0) {
    console.error(`[ops-alert] "${msg.subject}" suppressed — ALERT_EMAILS is unset`)
    return
  }
  try {
    await sendEmail(env, { to: recipients, subject: msg.subject, html: msg.html, text: msg.text })
  } catch (e) {
    console.error('[ops-alert] alert email itself failed', e)
  }
}

/**
 * Email a cron-failure alert to every address in `env.ALERT_EMAILS`.
 * Best-effort: never throws. No-ops (just logs) when no recipients are configured.
 */
export async function reportJobFailure(env: AlertEnv, opts: { job: string; error: unknown }): Promise<void> {
  const { job, error } = opts
  const recipients = alertRecipients(env)

  if (recipients.length === 0) {
    console.error(`[job:${job}] failed but ALERT_EMAILS is unset — no alert sent`)
    return
  }

  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  const subject = `[${PRODUCT_NAME}] cron failed: ${job}`

  const text =
    `Scheduled job "${job}" failed and did not complete.\n\n` +
    `Error: ${message}\n` +
    (stack ? `\nStack:\n${stack}\n` : '')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">
        Scheduled job <strong>${escHtml(job)}</strong> failed and did not complete.
      </p>
      <p style="margin: 0 0 8px; font-size: 13px; color: #94a3b8;">Error</p>
      <pre style="margin: 0 0 16px; padding: 12px; background: #f1f5f9; border-radius: 6px; font-size: 13px; line-height: 1.5; color: #0f172a; white-space: pre-wrap; overflow-wrap: anywhere;">${escHtml(message)}</pre>
      ${stack ? `<p style="margin: 0 0 8px; font-size: 13px; color: #94a3b8;">Stack</p>
      <pre style="margin: 0; padding: 12px; background: #f1f5f9; border-radius: 6px; font-size: 12px; line-height: 1.5; color: #475569; white-space: pre-wrap; overflow-wrap: anywhere;">${escHtml(stack)}</pre>` : ''}
    </div>
  `

  await sendOpsAlert(env, { subject, text, html })
}
