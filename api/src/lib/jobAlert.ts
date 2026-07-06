import type { Env } from '../types'
import { sendEmail } from './email'
import { PRODUCT_NAME } from '../../../shared/brand'

/**
 * Scheduled jobs run via `ctx.waitUntil(promise)`. If that promise rejects, the
 * error vanishes silently — which is how a tenant's nightly demo reset failed
 * (FK rollback) for ten days with nobody alerted. `runJob` wraps a job so any
 * throw is logged AND emailed to the operator, then swallowed so `ctx.waitUntil`
 * always observes success (the alert is the signal; re-throwing would only crash
 * the invocation without surfacing anything).
 */
export async function runJob(env: Env, name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(`[job:${name}] failed`, error)
    await reportJobFailure(env, { job: name, error })
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Email an alert to every address in `env.ALERT_EMAILS` (comma-separated).
 * ALERT_EMAILS is intentionally separate from superadmin access (central-governed):
 * superadmins have full domain access, which is not the same set as "who should receive ops alerts."
 * Best-effort: never throws. No-ops (just logs) when no recipients are configured.
 */
export async function reportJobFailure(env: Env, opts: { job: string; error: unknown }): Promise<void> {
  const { job, error } = opts
  const recipients = (env.ALERT_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

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

  try {
    await sendEmail(env, { to: recipients, subject, html, text })
  } catch (e) {
    console.error(`[job:${job}] alert email itself failed`, e)
  }
}
