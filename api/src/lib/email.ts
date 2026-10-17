import { eq, inArray } from 'drizzle-orm'
import type { Env, AppDb } from '../types'
import { associationConfig } from '../db/schema'
import { recordResendReading, recordResendThrottled } from './resendUsage'
import { recordAuthEvent } from './authEvents'
import { htmlToText } from '../../../shared/htmlToText'
import {
  createSender, resolveFrom as sharedResolveFrom, resolveFromBulk as sharedResolveFromBulk,
  resolveReplyTo as sharedResolveReplyTo, type EmailSender, type SenderEnv, type SignInMessage,
} from '../../../shared/emailSender'
import {
  cloudflareProvider, resendProvider, primaryProviderName, fallbackProviderName,
  type ProviderName, type CloudflareEmailBinding,
} from '../../../shared/emailProviders'
import { emailHealthRecorder } from './emailHealthRecorder'
import { resolveOrgNoun as _resolveOrgNoun } from '../../../shared/orgNoun'
import { PRODUCT_NAME } from '../../../shared/brand'
import { parseEmailList } from '../../../shared/operator'
import { color, fontSize } from '../../../shared/tokens'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'
import { isRecipientError, tally, recordSendStats } from './emailStats'
import { PermanentSendError } from './emailErrors'

// The shared purpose-level sender (shared/emailSender.ts) is replacing this
// module's send functions, one kind of email at a time (#705). Sign-in links
// go through it via sendMagicLink below, and the account and notification
// emails (email change, mentions, replies) through `senderFor`. sendEmail,
// sendBatch, and sendFeedback remain for the emails not yet moved; they use
// the same provider adapters (shared/emailProviders.ts).

/**
 * The shared sender for the API. With a `db`, every attempt of a purpose that
 * counts goes to email health (`email_send_stats` and the Resend usage
 * readout). Without one, nothing is counted.
 */
export function senderFor(env: SenderEnv, db?: AppDb): EmailSender {
  return createSender(env, { recorder: db ? emailHealthRecorder(db) : undefined })
}

export type { ProviderName, CloudflareEmailBinding }

export type EmailMessage = {
  to: string[]
  subject: string
  html: string
  text?: string       // optional; auto-derived from html when omitted
  from?: string       // defaults to EMAIL_FROM env (else notifications@example.com)
  replyTo?: string    // defaults to EMAIL_REPLY_TO, then EMAIL_FROM (else notifications@example.com)
  headers?: Record<string, string>  // custom headers (e.g. List-Unsubscribe)
}

export type EmailSendResult = {
  ok: boolean
  provider: ProviderName
  error?: string
  messageId?: string
  /** Every attempt, in order, when sendEmail made them. This result's own fields are the last attempt's. */
  attempts?: EmailSendResult[]
}

export type SendOptions = {
  /**
   * Retry once through the other provider when the first attempt fails for a
   * reason that is not specific to the recipient. Magic links only: a login
   * link that does not arrive locks someone out, and a digest that does not
   * arrive does not.
   */
  fallback?: boolean
  /** Send through this provider instead of the active one. The outage alert uses it. */
  provider?: ProviderName
}

/** Sender line, e.g. "FloorVote <notifications@example.com>", from EMAIL_FROM (falls back to example.com). */
export function resolveFrom(env: Pick<Env, 'EMAIL_FROM'>): string {
  return sharedResolveFrom(env)
}

/**
 * Sender line for BULK mail (daily digest, week-ahead). Uses EMAIL_FROM_BULK when
 * set — a dedicated sending subdomain (e.g. `notifications@mail.floor.vote`) that
 * segments bulk-mail reputation away from transactional login mail, so a spam
 * complaint on a digest can't degrade magic-link deliverability. Falls back to
 * EMAIL_FROM (then the example.com fallback) when unset, so this is inert until an
 * operator verifies the subdomain and sets the var.
 */
export function resolveFromBulk(env: Pick<Env, 'EMAIL_FROM' | 'EMAIL_FROM_BULK'>): string {
  return sharedResolveFromBulk(env)
}

/** Reply-To, from EMAIL_REPLY_TO, else EMAIL_FROM, else the example.com fallback. */
export function resolveReplyTo(env: Pick<Env, 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>): string {
  return sharedResolveReplyTo(env)
}

/**
 * RFC-2369 List-Unsubscribe header for recurring mail (digest, week-ahead),
 * pointing at the in-app opt-out the recipient already controls
 * (`/profile#<anchor>`). Improves bulk deliverability; no new endpoint needed.
 */
export function unsubscribeHeaders(appUrl: string, anchor: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${appUrl}/profile#${anchor}>` }
}

// `text` is always resolved (derived from html when not supplied).
type ResolvedMessage = EmailMessage & { from: string; replyTo: string; text: string }

type SendEnv = Pick<Env, 'RESEND_API_KEY' | 'EMAIL_PROVIDER' | 'EMAIL' | 'DEMO_MODE' | 'EMAIL_FROM' | 'EMAIL_FROM_BULK' | 'EMAIL_REPLY_TO'>

export function activeProvider(env: Pick<Env, 'EMAIL_PROVIDER' | 'EMAIL'>): ProviderName {
  return primaryProviderName(env) // the binding when chosen and bound, else Resend (the fail-safe default)
}

/** The provider that is not `primary`, if it is configured. */
export function otherProvider(env: Pick<Env, 'RESEND_API_KEY' | 'EMAIL'>, primary: ProviderName): ProviderName | null {
  return fallbackProviderName(env, primary)
}

function resolveMessage(env: SendEnv, message: EmailMessage): ResolvedMessage {
  return {
    ...message,
    from: message.from ?? resolveFrom(env),
    replyTo: message.replyTo ?? resolveReplyTo(env),
    text: message.text ?? htmlToText(message.html),
  }
}

async function sendVia(env: SendEnv, msg: ResolvedMessage, provider: ProviderName, db?: AppDb): Promise<EmailSendResult> {
  const adapter = provider === 'cloudflare' ? cloudflareProvider(env.EMAIL) : resendProvider(env.RESEND_API_KEY)
  const a = await adapter.send(msg)
  if (db && a.usage) {
    try {
      await recordResendReading(db, a.usage)
      if (a.usage.throttled) await recordResendThrottled(db)
    } catch (e) { console.error('[resend-record]', e) }
  }
  return a.ok
    ? { ok: true, provider: a.provider, messageId: a.messageId }
    : { ok: false, provider: a.provider, error: a.error }
}

/**
 * Send one message. Applies From/Reply-To defaults. Never throws.
 *
 * With a `db`, every attempt is counted in email_send_stats for the email-health
 * job, including the failed primary attempt of a send that fallback rescued. That
 * is deliberate: fallback hides an outage from users, so the detector has to see
 * the primary failing even when nobody else can.
 */
export async function sendEmail(env: SendEnv, message: EmailMessage, db?: AppDb, opts: SendOptions = {}): Promise<EmailSendResult> {
  const msg = resolveMessage(env, message)
  const first = opts.provider ?? activeProvider(env)
  const attempts = [await sendVia(env, msg, first, db)]
  const second = otherProvider(env, first)
  if (opts.fallback && !attempts[0].ok && !isRecipientError(attempts[0]) && second) {
    console.warn(`[email] ${first} failed (${attempts[0].error}) — retrying via ${second}`)
    attempts.push(await sendVia(env, msg, second, db))
  }
  if (db) for (const a of attempts) await recordSendStats(db, a.provider, tally([a]))
  return { ...attempts[attempts.length - 1], attempts }
}

/**
 * Max emails in flight at once during a bulk send. Bounds the burst so we don't
 * trip provider rate limits or widen the resend usage-tracking race window,
 * while still collapsing the wall-clock of large fan-outs (a 650-recipient
 * digest sent one-at-a-time takes minutes inside a single cron invocation).
 */
const BATCH_CONCURRENCY = 8

/**
 * Bulk send: provider-agnostic, bounded-concurrency fan-out. Suppressed entirely
 * in DEMO_MODE. Returns {sent, failed}.
 *
 * Pass `{ bulk: true }` for recurring mass mail (digest, week-ahead): messages
 * that don't set their own `from` inherit the bulk sender (EMAIL_FROM_BULK), so
 * bulk reputation can be segmented onto a dedicated sending subdomain.
 */
export async function sendBatch(env: SendEnv, messages: EmailMessage[], tag = 'email', db?: AppDb, opts?: { bulk?: boolean }): Promise<{ sent: number; failed: number }> {
  if (messages.length === 0) return { sent: 0, failed: 0 }
  if (env.DEMO_MODE === 'true') {
    console.log(`[${tag}] demo mode — suppressing ${messages.length} email(s)`)
    return { sent: 0, failed: 0 }
  }
  const bulkFrom = opts?.bulk ? resolveFromBulk(env) : undefined
  const provider = activeProvider(env)
  const results: EmailSendResult[] = []
  for (let i = 0; i < messages.length; i += BATCH_CONCURRENCY) {
    const chunk = messages.slice(i, i + BATCH_CONCURRENCY)
    results.push(...await Promise.all(chunk.map(m =>
      sendVia(env, resolveMessage(env, bulkFrom && !m.from ? { ...m, from: bulkFrom } : m), provider, db))))
  }
  // One write for the whole run rather than one per recipient: a 650-recipient
  // digest would otherwise cost 650 upserts.
  if (db) await recordSendStats(db, provider, tally(results))
  const sent = results.filter(r => r.ok).length
  const failed = results.length - sent
  console.log(`[${tag}] sent ${sent}, failed ${failed}`)
  return { sent, failed }
}


export function wordmarkHtml(appUrl: string): string {
  // The full lockup (mark + "FloorVote" in Archivo) ships as a hosted PNG. Email
  // clients can't load the brand font, so the name is an image, not live text —
  // that was the whole point. alt carries the name for screen readers and for
  // images-off clients (Outlook blocks images by default). The PNG is rendered
  // from the outlined brand SVG by scripts/gen-brand-assets.ts (npm run
  // gen:brand-assets); display 150×24 with height:auto to hold the ~6.3:1 ratio.
  return `
  <div style="margin-bottom:4px;">
    <img src="${appUrl}/email-icons/wordmark.png" alt="FloorVote" width="150" height="24" style="display:block;border:0;height:auto;">
  </div>
`
}

// Resolve the org's display name: config row → env.ASSOCIATION_NAME → undefined.
// Mirrors the fallback order in routes/configApi.ts and weekAhead.ts.
export async function resolveAssocName(
  env: Pick<Env, 'ASSOCIATION_NAME'>,
  db?: AppDb,
): Promise<string | undefined> {
  if (db) {
    const row = await db
      .select()
      .from(associationConfig)
      .where(eq(associationConfig.key, 'association_name'))
      .get()
    if (row?.value) {
      try {
        return JSON.parse(row.value) as string
      } catch {
        return row.value
      }
    }
  }
  return env.ASSOCIATION_NAME || undefined
}

// Resolve the org noun ("team" / "association" / "coalition" / etc.) for use in
// copy. Reads `org_noun` and `position_label` from association_config (mirrors
// resolveAssocName's query pattern), then delegates to shared resolveOrgNoun.
async function resolveOrgNounFromDb(db?: AppDb): Promise<string> {
  if (db) {
    const rows = await db
      .select()
      .from(associationConfig)
      .where(inArray(associationConfig.key, ['org_noun', 'position_label']))
      .all()
    const parseVal = (v: string | null | undefined) => {
      if (!v) return null
      try { return JSON.parse(v) as string } catch { return v }
    }
    const orgNounVal = parseVal(rows.find((r) => r.key === 'org_noun')?.value)
    const posLabelVal = parseVal(rows.find((r) => r.key === 'position_label')?.value)
    return _resolveOrgNoun(orgNounVal, posLabelVal)
  }
  return _resolveOrgNoun()
}

/**
 * A sign-in purpose message (shared/emailSender.ts) for a login or invite
 * link. Pure: the association name and org noun are inputs, and so is the
 * sign-in event writer, rather than side effects of passing a database.
 */
export function buildSignInMessage(input: {
  to: string
  link: 'login' | 'invite'
  magicLinkUrl: string
  appUrl: string
  /** The org's display name, when it has one. */
  assocName?: string
  /** "team", "association", and so on. Used by an invite when there is no display name. */
  orgNoun?: string
  recordEvent?: SignInMessage['recordEvent']
}): SignInMessage {
  const { link, magicLinkUrl, appUrl, assocName, orgNoun } = input
  const isInvite = link === 'invite'
  const orgPhrase = assocName ? escHtml(assocName) : `your ${escHtml(orgNoun ?? '')}`

  // Hand-written plain-text part (the html auto-derive would say "click the
  // button below", which is wrong with no button). This is the login path, so
  // keep the URL prominent for text-only clients.
  const text = isInvite
    ? `You've been added to ${assocName ?? `your ${orgNoun}`} on ${PRODUCT_NAME}, a legislative tracking tool. Set up your account:\n\n${magicLinkUrl}\n\nThis link expires in 7 days and can only be used once. You can also request a new sign-in link anytime using this email address:\n\n${appUrl}\n\nIf you didn't expect this email, you can safely ignore it.`
    : `You requested a sign-in link for ${PRODUCT_NAME}. Open this link to access your account:\n\n${magicLinkUrl}\n\nThis link expires in 1 hour and can only be used once. If you didn't expect this email, you can safely ignore it.`

  const { subject, html } = renderMagicLinkEmail({ type: link, magicLinkUrl, appUrl, instanceName: assocName ?? '', orgPhrase })
  return { purpose: 'sign-in', link, to: [input.to], subject, html, text, ...(input.recordEvent && { recordEvent: input.recordEvent }) }
}

/**
 * Send a login or invite link through the shared sender's sign-in purpose:
 * fallback to the other provider on a temporary failure, an invite suppressed
 * in demo mode (a login link still sends: the operator's own way into a demo
 * arrives by one), and a malformed address refused before any provider.
 *
 * With a `db`, it reads the association name and org noun, counts every
 * attempt toward email health, and writes one auth event per attempt. Without
 * one, it does none of those.
 *
 * Resolves when the link was sent or demo mode suppressed it. Throws
 * PermanentSendError when the address can't receive mail (the invite queue
 * acks), and a plain Error for a temporary failure (the queue retries).
 */
export async function sendMagicLink(
  to: string,
  magicLinkUrl: string,
  env: Pick<Env, 'RESEND_API_KEY' | 'APP_URL' | 'EMAIL_PROVIDER' | 'EMAIL' | 'DEMO_MODE' | 'ASSOCIATION_NAME' | 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>,
  type: 'login' | 'invite' = 'login',
  db?: AppDb,
  userId?: string,
): Promise<void> {
  const message = buildSignInMessage({
    to, link: type, magicLinkUrl, appUrl: env.APP_URL,
    assocName: await resolveAssocName(env, db),
    orgNoun: type === 'invite' ? await resolveOrgNounFromDb(db) : undefined,
    recordEvent: db
      ? async (e) => {
        await recordAuthEvent(db, {
          event: e.event, email: to, userId: userId ?? null, reason: e.reason,
          linkType: type, provider: e.provider, messageId: e.messageId,
        })
      }
      : undefined,
  })
  const r = await senderFor(env, db).send(message)
  if (r.ok) return
  const msg = r.provider ? `Email send failed (${r.provider}): ${r.error}` : r.error
  throw r.permanent ? new PermanentSendError(msg) : new Error(msg)
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Pure renderer for the magic-link (login/invite) email. Shared by sendMagicLink
 * and the sample registry (renderSampleEmail) so the real and sample emails can't
 * drift. `orgPhrase` is pre-escaped by the caller (invite body only).
 */
export function renderMagicLinkEmail(input: {
  type: 'login' | 'invite'
  magicLinkUrl: string
  appUrl: string
  instanceName: string
  orgPhrase: string
}): { subject: string; html: string } {
  const isInvite = input.type === 'invite'
  const subject = isInvite ? `You've been invited to ${PRODUCT_NAME}` : `Your sign-in link for ${PRODUCT_NAME}`
  const bodyText = isInvite
    ? `You've been added to ${input.orgPhrase} on ${PRODUCT_NAME}, a legislative tracking tool. Click below to set up your account. This link expires in 7 days and can only be used once. You can also <a href="${input.appUrl}" style="color: ${color.linkBlue};">request a new sign-in link</a> anytime using this email address.`
    : 'You requested a sign-in link. Click the button below to access your account. This link expires in 1 hour and can only be used once.'
  const buttonLabel = isInvite ? 'Accept your invitation' : `Sign in to ${PRODUCT_NAME}`
  const html = renderEmailShell({
    instanceName: input.instanceName,
    appUrl: input.appUrl,
    signalHtml: isInvite ? 'You\'ve been invited' : `Sign in to ${PRODUCT_NAME}`,
    bodyHtml: `<p style="margin:0;font-size:${fontSize.base}px;line-height:1.6;color:${color.textSlate};">${bodyText}</p>`,
    ctaHtml: emailButton(input.magicLinkUrl, buttonLabel),
    footerHtml: `If you didn't expect this email, you can safely ignore it.<br>${emailFooterLink(escHtml(input.appUrl), PRODUCT_NAME)}`,
  })
  return { subject, html }
}

export async function sendFeedback(
  from: { email: string },
  message: string,
  pageUrl: string | undefined,
  env: Pick<Env, 'RESEND_API_KEY' | 'EMAIL_PROVIDER' | 'EMAIL' | 'DEMO_MODE' | 'OPERATOR_CONTACT_EMAILS' | 'ASSOCIATION_NAME' | 'APP_URL'>,
  db?: AppDb,
): Promise<void> {
  const html = renderEmailShell({
    instanceName: (await resolveAssocName(env, db)) ?? '',
    appUrl: env.APP_URL,
    signalHtml: 'New feedback',
    bodyHtml: `
        <p style="margin:0 0 8px;font-size:${fontSize.sm}px;color:${color.textMuted};">From: ${escHtml(from.email)}</p>
        ${pageUrl ? `<p style="margin:0 0 16px;font-size:${fontSize.sm}px;color:${color.textMuted};">Page: ${escHtml(pageUrl)}</p>` : ''}
        <p style="margin:0;font-size:${fontSize.base}px;line-height:1.6;color:${color.textSlate};white-space:pre-wrap;">${escHtml(message)}</p>`,
    footerHtml: '',
  })
  const recipients = parseEmailList(env.OPERATOR_CONTACT_EMAILS)
  if (recipients.length === 0) {
    throw new Error('Feedback not configured — OPERATOR_CONTACT_EMAILS is empty')
  }
  const r = await sendEmail(env, { to: recipients, subject: `Feedback from ${from.email}`, html }, db)
  if (!r.ok) {
    // A suppressed recipient stays suppressed; only a provider failure is worth retrying.
    const msg = `Email send failed (${r.provider}): ${r.error}`
    throw isRecipientError(r) ? new PermanentSendError(msg) : new Error(msg)
  }
}
