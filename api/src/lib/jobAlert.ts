import type { Env } from '../types'
import { getDb } from '../db/client'
import { senderFor } from './email'
import { joinJobAlertThread, takeJobAlertThread } from './alertThread'
import { toDbTs } from './dbTime'
import { PRODUCT_NAME } from '../../../shared/brand'
import { validEmailList } from '../../../shared/operator'
import { errorText } from '../../../shared/errorText'
import { alertThreadHeaders, type JobThread } from '../../../shared/alertThread'

/**
 * Scheduled jobs run via `ctx.waitUntil(promise)`. If that promise rejects, the
 * error vanishes silently — which is how a tenant's nightly demo reset failed
 * (FK rollback) for ten days with nobody alerted. `runJob` wraps a job so any
 * throw is logged AND emailed to the operator, then swallowed so `ctx.waitUntil`
 * always observes success (the alert is the signal; re-throwing would only crash
 * the invocation without surfacing anything).
 *
 * A run that does its work after a failure that alerted sends one resolved
 * email (reportJobResolved). A job that did no work this run says why: a run
 * that isn't its day returns `{ skipped: 'not-today' }` and leaves the
 * conversation open, and one that finds the job switched off returns
 * `{ skipped: 'off' }` and ends the conversation without an email.
 */
export async function runJob(env: Env, name: string, fn: () => Promise<unknown>): Promise<void> {
  let result: unknown
  try {
    result = await fn()
  } catch (error) {
    console.error(`[job:${name}] failed`, errorText(error), error)
    await reportJobFailure(env, { job: name, error })
    return
  }
  const skipped = skippedRun(result)
  if (skipped === 'off') await endJobConversation(env, name)
  else if (!skipped) await reportJobResolved(env, name)
}

/** What a job returns when it did no work this run, and why. */
export type JobSkipped = { skipped: 'off' | 'not-today' }

/** Why a run did no work, from what the job returned, or null when it did its work. Any other truthy `skipped` counts as not its day. */
function skippedRun(result: unknown): JobSkipped['skipped'] | null {
  const skipped = typeof result === 'object' && result !== null ? (result as { skipped?: unknown }).skipped : undefined
  if (skipped === 'off') return 'off'
  return skipped ? 'not-today' : null
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The instance's address from APP_URL, which its alerts name, or null when it can't be read. */
function instanceSite(env: Pick<Env, 'APP_URL'>): { host: string; hostname: string } | null {
  try {
    const url = new URL(env.APP_URL)
    return url.hostname ? { host: url.host, hostname: url.hostname } : null
  } catch {
    return null
  }
}

/** A failure alert's subject, which also names its job's conversation in Outlook. */
const failureSubject = (job: string, where: string) => `[${PRODUCT_NAME}] cron failed: ${job}${where}`

/** An alert's message, with the headers that put it in its job's conversation, if any. */
type AlertMessage = { subject: string; text: string; html: string; headers?: Record<string, string> }

/**
 * Send one alert to the recipients. An alert that no provider takes with its
 * conversation headers goes once more without them: no provider is known to
 * refuse these headers, but if one did, the alert must still arrive. Never
 * throws.
 */
async function sendAlert(env: Env, job: string, recipients: string[], msg: AlertMessage): Promise<void> {
  try {
    // The operator purpose never counts toward email health (alert mail goes to
    // operator addresses, which a verified-only outage keeps delivering to, so
    // counting it would let the detector falsely declare recovery), so no db.
    const sender = senderFor(env)
    const send = (h?: Record<string, string>) => sender.send({ purpose: 'operator', to: recipients, subject: msg.subject, html: msg.html, text: msg.text, ...(h && { headers: h }) })
    let r = await send(msg.headers)
    if (!r.ok && msg.headers && !r.permanent) {
      console.error(`[job:${job}] alert not sent with its conversation headers (${r.error}), so it goes once more without them`)
      r = await send()
    }
    if (!r.ok) console.error(`[job:${job}] alert email itself failed (${r.provider ?? 'no provider'}): ${r.error}`)
  } catch (e) {
    console.error(`[job:${job}] alert email itself failed`, errorText(e), e)
  }
}

/**
 * The headers that put an alert in its job's conversation on this instance
 * (lib/alertThread.ts, shared/alertThread.ts), or none when the conversation
 * can't be read or written: the alert matters more, so it goes out on its own.
 */
async function jobThreadHeaders(env: Env, job: string, subject: string, hostname: string): Promise<Record<string, string> | undefined> {
  try {
    const thread = await joinJobAlertThread(getDb(env.DB), job)
    return await alertThreadHeaders({ key: job, startedAt: thread.startedAt, domain: hostname, topic: subject })
  } catch (e) {
    console.error(`[job:${job}] couldn't record the alert's conversation, so it goes out on its own:`, errorText(e), e)
    return undefined
  }
}

/**
 * Email an alert to every valid address in `env.ALERT_EMAILS` (comma-separated).
 * An entry that is not an address is logged and skipped, so one typo can't block the rest.
 * ALERT_EMAILS is intentionally separate from superadmin access (central-governed):
 * superadmins have full domain access, which is not the same set as "who should receive ops alerts."
 * The alert names the instance, and joins its job's conversation, so repeated
 * failures of one job read as one outage (lib/alertThread.ts).
 * Best-effort: never throws. No-ops (just logs) when no valid recipient is configured.
 */
export async function reportJobFailure(env: Env, opts: { job: string; error: unknown }): Promise<void> {
  const { job, error } = opts
  const recipients = validEmailList(env.ALERT_EMAILS, 'ALERT_EMAILS')

  if (recipients.length === 0) {
    console.error(`[job:${job}] failed but ALERT_EMAILS is unset or has no valid address — no alert sent`)
    return
  }

  const message = errorText(error)
  const stack = error instanceof Error ? error.stack : undefined
  const site = instanceSite(env)
  const where = site ? ` on ${site.host}` : ''
  const subject = failureSubject(job, where)

  const text =
    `Scheduled job "${job}" failed${where} and did not complete.\n\n` +
    `Error: ${message}\n` +
    (stack ? `\nStack:\n${stack}\n` : '')

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">
        Scheduled job <strong>${escHtml(job)}</strong> failed${escHtml(where)} and did not complete.
      </p>
      <p style="margin: 0 0 8px; font-size: 13px; color: #94a3b8;">Error</p>
      <pre style="margin: 0 0 16px; padding: 12px; background: #f1f5f9; border-radius: 6px; font-size: 13px; line-height: 1.5; color: #0f172a; white-space: pre-wrap; overflow-wrap: anywhere;">${escHtml(message)}</pre>
      ${stack ? `<p style="margin: 0 0 8px; font-size: 13px; color: #94a3b8;">Stack</p>
      <pre style="margin: 0; padding: 12px; background: #f1f5f9; border-radius: 6px; font-size: 12px; line-height: 1.5; color: #475569; white-space: pre-wrap; overflow-wrap: anywhere;">${escHtml(stack)}</pre>` : ''}
    </div>
  `

  const headers = site && env.DB ? await jobThreadHeaders(env, job, subject, site.hostname) : undefined
  await sendAlert(env, job, recipients, { subject, text, html, headers })
}

/**
 * End the job's open conversation without an email, after a run that found
 * the job switched off: no run will do its work to resolve it. Best-effort:
 * never throws.
 */
async function endJobConversation(env: Env, job: string): Promise<void> {
  if (!instanceSite(env) || !env.DB) return
  try {
    await takeJobAlertThread(getDb(env.DB), job)
  } catch (e) {
    console.error(`[job:${job}] couldn't end the job's alert conversation after a run that found it switched off:`, errorText(e), e)
  }
}

/**
 * After a run that did its work, a job whose failure alerted (an open
 * conversation in job_alert_threads, lib/alertThread.ts) sends one resolved
 * email in that conversation, which then ends. Best-effort: never throws.
 */
export async function reportJobResolved(env: Env, job: string): Promise<void> {
  const site = instanceSite(env)
  if (!site || !env.DB) return
  let thread: JobThread | null
  try {
    thread = await takeJobAlertThread(getDb(env.DB), job)
  } catch (e) {
    console.error(`[job:${job}] couldn't read the job's alert conversation, so its resolved email waits for the next run that does its work:`, errorText(e), e)
    return
  }
  if (!thread) return
  const recipients = validEmailList(env.ALERT_EMAILS, 'ALERT_EMAILS')
  if (recipients.length === 0) return

  const where = ` on ${site.host}`
  const since = toDbTs(new Date(thread.startedAt))
  const subject = `[${PRODUCT_NAME}] resolved: ${job}${where}`
  const text = `Scheduled job "${job}" ran${where} without an error, after failing since ${since} UTC.\n`
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; color: #0f172a;">
      <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #334155;">
        Scheduled job <strong>${escHtml(job)}</strong> ran${escHtml(where)} without an error, after failing since ${since} UTC.
      </p>
    </div>
  `
  let headers: Record<string, string> | undefined
  try {
    headers = await alertThreadHeaders({ key: job, startedAt: thread.startedAt, domain: site.hostname, topic: failureSubject(job, where) })
  } catch (e) {
    console.error(`[job:${job}] couldn't build the resolved email's conversation headers, so it goes out on its own:`, errorText(e), e)
  }
  await sendAlert(env, job, recipients, { subject, text, html, headers })
}
