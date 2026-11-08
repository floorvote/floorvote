import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/schema'
import type { Db, Env } from '../types'
import { centralSender } from './sender'
import { joinAlertThread, type JobThread } from './alertThread'
import { PRODUCT_NAME } from '../../../shared/brand'
import { validEmailList } from '../../../shared/operator'
import { errorText } from '../../../shared/errorText'
import { alertThreadHeaders } from '../../../shared/alertThread'

// Structural subset of the env that jobAlert needs, so callers and tests can
// pass a minimal env rather than a full `Env`. Without DB, a failure alert
// still goes out, just outside its job's conversation.
type AlertEnv = Pick<Env, 'RESEND_API_KEY' | 'EMAIL_PROVIDER' | 'EMAIL' | 'EMAIL_FROM' | 'EMAIL_REPLY_TO' | 'ALERT_EMAILS'> & Partial<Pick<Env, 'DB'>>

/** An ops alert's content, with the headers that put it in a conversation, if any. */
type OpsMessage = { subject: string; text: string; html: string; headers?: Record<string, string> }

/** A failure alert's subject, which also names its job's conversation in Outlook. */
const failureSubject = (job: string) => `[${PRODUCT_NAME}] cron failed: ${job}`

/**
 * Scheduled jobs run via `ctx.waitUntil(promise)`; a rejected promise vanishes
 * silently. `runJob` wraps a job so any throw is logged AND emailed to the
 * operator, then swallowed so `ctx.waitUntil` always observes success.
 */
export async function runJob(env: AlertEnv, name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(`[job:${name}] failed`, errorText(error), error)
    await reportJobFailure(env, { job: name, error })
  }
}

/**
 * The headers that put an email in the job's conversation that started at
 * `startedAt` (lib/alertThread.ts). The root's domain is the sender's, when it
 * is a plain host name, else the sender's own fallback.
 */
export function jobThreadHeaders(env: Pick<AlertEnv, 'EMAIL_FROM'>, job: string, startedAt: number): Promise<Record<string, string>> {
  const domain = env.EMAIL_FROM?.split('@')[1]?.trim()
  return alertThreadHeaders({ key: job, startedAt, domain: domain && /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'example.com', topic: failureSubject(job) })
}

/**
 * Join the job's open conversation, or start one, for an alert about to go
 * out: the conversation as this alert left it, and the email's headers. Null
 * when the conversation can't be read or written, so the email goes out on
 * its own; an alert matters more than its conversation.
 */
export async function joinJobThread(env: Pick<AlertEnv, 'EMAIL_FROM'>, db: Db, job: string): Promise<{ thread: JobThread; headers: Record<string, string> } | null> {
  try {
    const thread = await joinAlertThread(db, job)
    return { thread, headers: await jobThreadHeaders(env, job, thread.startedAt) }
  } catch (e) {
    console.error(`[job:${job}] couldn't record the alert's conversation, so it goes out on its own:`, errorText(e), e)
    return null
  }
}

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The configured ops-alert recipients (`env.ALERT_EMAILS`, comma-separated),
 * valid addresses only: an entry that isn't one is logged and skipped, so a
 * single typo can't make the sender reject the alert to every good address.
 * ALERT_EMAILS is intentionally separate from SUPERADMIN_EMAILS: superadmins have
 * full domain access, which is not the same set as "who should receive ops alerts."
 */
function alertRecipients(env: AlertEnv): string[] {
  return validEmailList(env.ALERT_EMAILS, 'ALERT_EMAILS')
}

/**
 * Best-effort ops alert: send `{ subject, text, html }`, and any conversation
 * `headers`, to every `alertRecipients` address through the shared sender with
 * the operator purpose (so it falls back to the second provider when central
 * has both). Never throws; no-ops (just logs) when no recipients, and logs a
 * send that fails.
 */
export async function sendOpsAlert(env: AlertEnv, msg: OpsMessage): Promise<void> {
  const recipients = alertRecipients(env)
  if (recipients.length === 0) {
    console.error(`[ops-alert] "${msg.subject}" suppressed — ALERT_EMAILS is unset or has no valid address`)
    return
  }
  await sendTo(env, recipients, msg)
}

/**
 * The send itself, to recipients already chosen, so a caller that checked them
 * once doesn't parse (and log) the setting again. An alert that no provider
 * takes with its conversation headers goes once more without them: no
 * provider is known to refuse these headers, but if one did, the alert must
 * still arrive.
 */
async function sendTo(env: AlertEnv, recipients: string[], msg: OpsMessage): Promise<void> {
  try {
    const sender = centralSender(env)
    const send = (headers?: Record<string, string>) => sender.send({
      purpose: 'operator', to: recipients, subject: msg.subject, html: msg.html, text: msg.text,
      ...(headers && { headers }),
    })
    let r = await send(msg.headers)
    if (!r.ok && msg.headers && !r.permanent) {
      console.error(`[ops-alert] "${msg.subject}" not sent with its conversation headers (${r.error}), so it goes once more without them`)
      r = await send()
    }
    if (!r.ok) console.error(`[ops-alert] "${msg.subject}" not sent: ${r.error}`)
  } catch (e) {
    console.error('[ops-alert] alert email itself failed', errorText(e), e)
  }
}

/**
 * Email a cron-failure alert to every valid address in `env.ALERT_EMAILS`, in
 * its job's conversation (lib/alertThread.ts) when `env.DB` is there.
 * Best-effort: never throws. No-ops (just logs) when no valid recipient is configured.
 */
export async function reportJobFailure(env: AlertEnv, opts: { job: string; error: unknown }): Promise<void> {
  const { job, error } = opts
  const recipients = alertRecipients(env)

  if (recipients.length === 0) {
    console.error(`[job:${job}] failed but ALERT_EMAILS is unset or has no valid address — no alert sent`)
    return
  }

  const message = errorText(error)
  const stack = error instanceof Error ? error.stack : undefined
  const subject = failureSubject(job)

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

  const thread = env.DB ? await joinJobThread(env, drizzle(env.DB, { schema }), job) : null
  await sendTo(env, recipients, { subject, text, html, headers: thread?.headers })
}
