import { eq, inArray } from 'drizzle-orm'
import type { Env, AppDb } from '../types'
import { associationConfig } from '../db/schema'
import { recordResendUsage, recordResendThrottle } from './resendUsage'
import { recordAuthEvent } from './authEvents'
import { htmlToText } from '../../../shared/htmlToText'
import { resolveOrgNoun as _resolveOrgNoun } from '../../../shared/orgNoun'
import { PRODUCT_NAME } from '../../../shared/brand'
import { parseEmailList } from '../../../shared/operator'
import { color, fontSize } from '../../../shared/tokens'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'

export type ProviderName = 'resend' | 'cloudflare'

export type EmailMessage = {
  to: string[]
  subject: string
  html: string
  text?: string       // optional; auto-derived from html when omitted
  from?: string       // defaults to EMAIL_FROM env (else notifications@example.com)
  replyTo?: string    // defaults to EMAIL_REPLY_TO, then EMAIL_FROM (else notifications@example.com)
  headers?: Record<string, string>  // custom headers (e.g. List-Unsubscribe)
}

export type EmailSendResult = { ok: boolean; provider: ProviderName; error?: string; messageId?: string }

// Single fallback when no EMAIL_FROM is configured.
const FALLBACK_EMAIL = 'notifications@example.com'

/** Sender line, e.g. "FloorVote <notifications@example.com>", from EMAIL_FROM (falls back to example.com). */
export function resolveFrom(env: Pick<Env, 'EMAIL_FROM'>): string {
  return `${PRODUCT_NAME} <${env.EMAIL_FROM ?? FALLBACK_EMAIL}>`
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
  return `${PRODUCT_NAME} <${env.EMAIL_FROM_BULK ?? env.EMAIL_FROM ?? FALLBACK_EMAIL}>`
}

/** Reply-To, from EMAIL_REPLY_TO, else EMAIL_FROM, else the example.com fallback. */
export function resolveReplyTo(env: Pick<Env, 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>): string {
  return env.EMAIL_REPLY_TO ?? env.EMAIL_FROM ?? FALLBACK_EMAIL
}

/**
 * RFC-2369 List-Unsubscribe header for recurring mail (digest, week-ahead),
 * pointing at the in-app opt-out the recipient already controls
 * (`/profile#<anchor>`). Improves bulk deliverability; no new endpoint needed.
 */
export function unsubscribeHeaders(appUrl: string, anchor: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${appUrl}/profile#${anchor}>` }
}

// Minimal shape of the Cloudflare Email Service `[[send_email]]` binding (beta).
// Defined locally to avoid depending on an unstable @cloudflare/workers-types export.
export interface CloudflareEmailBinding {
  send(message: {
    to: string | string[]
    from: string
    subject: string
    html?: string
    text?: string
    replyTo?: string | string[]
    headers?: Record<string, string>
  }): Promise<{ messageId?: string }>
}


// `text` is always resolved (derived from html when not supplied).
type ResolvedMessage = EmailMessage & { from: string; replyTo: string; text: string }

type SendEnv = Pick<Env, 'RESEND_API_KEY' | 'EMAIL_PROVIDER' | 'EMAIL' | 'DEMO_MODE' | 'EMAIL_FROM' | 'EMAIL_FROM_BULK' | 'EMAIL_REPLY_TO'>

export function activeProvider(env: Pick<Env, 'EMAIL_PROVIDER' | 'EMAIL'>): ProviderName {
  if (env.EMAIL_PROVIDER === 'cloudflare' && env.EMAIL) return 'cloudflare'
  return 'resend' // fail-safe default to the proven path
}

async function resendSend(env: Pick<Env, 'RESEND_API_KEY'>, msg: ResolvedMessage, db?: AppDb): Promise<EmailSendResult> {
  const body: Record<string, unknown> = { from: msg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, reply_to: msg.replyTo }
  if (msg.headers) body.headers = msg.headers
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (db) {
    try { await recordResendUsage(db, res); await recordResendThrottle(db, res) }
    catch (e) { console.error('[resend-record]', e) }
  }
  if (!res.ok) {
    console.error(`[email:resend] ${res.status} ${await res.text()}`)
    return { ok: false, provider: 'resend', error: String(res.status) }
  }
  const json = await res.json().catch(() => ({})) as { id?: string }
  return { ok: true, provider: 'resend', messageId: json.id }
}

async function cloudflareSend(env: Pick<Env, 'EMAIL'>, msg: ResolvedMessage): Promise<EmailSendResult> {
  try {
    const resp = await env.EMAIL!.send({ to: msg.to, from: msg.from, subject: msg.subject, html: msg.html, text: msg.text, replyTo: msg.replyTo, headers: msg.headers })
    return { ok: true, provider: 'cloudflare', messageId: resp?.messageId }
  } catch (e: unknown) {
    // The binding throws a standard Error with a `.code` (e.g. E_RECIPIENT_SUPPRESSED,
    // E_RATE_LIMIT_EXCEEDED). Surface the code so a bounced/suppressed send is diagnosable.
    const message = e instanceof Error ? e.message : String(e)
    const code = (e as { code?: string })?.code
    const detail = code ? `${code}: ${message}` : message
    console.error('[email:cloudflare]', detail)
    return { ok: false, provider: 'cloudflare', error: detail }
  }
}

/** Send one message via the active provider. Applies From/Reply-To defaults. Never throws. */
export async function sendEmail(env: SendEnv, message: EmailMessage, db?: AppDb): Promise<EmailSendResult> {
  const msg: ResolvedMessage = {
    ...message,
    from: message.from ?? resolveFrom(env),
    replyTo: message.replyTo ?? resolveReplyTo(env),
    text: message.text ?? htmlToText(message.html),
  }
  return activeProvider(env) === 'cloudflare' ? cloudflareSend(env, msg) : resendSend(env, msg, db)
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
  let sent = 0, failed = 0
  for (let i = 0; i < messages.length; i += BATCH_CONCURRENCY) {
    const chunk = messages.slice(i, i + BATCH_CONCURRENCY)
    const results = await Promise.all(chunk.map(m =>
      sendEmail(env, bulkFrom && !m.from ? { ...m, from: bulkFrom } : m, db)))
    for (const r of results) { if (r.ok) sent++; else failed++ }
  }
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

export async function sendMagicLink(
  to: string,
  magicLinkUrl: string,
  env: Pick<Env, 'RESEND_API_KEY' | 'APP_URL' | 'EMAIL_PROVIDER' | 'EMAIL' | 'DEMO_MODE' | 'ASSOCIATION_NAME' | 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>,
  type: 'login' | 'invite' = 'login',
  db?: AppDb,
  userId?: string,
): Promise<void> {
  const isInvite = type === 'invite'
  const assocName = await resolveAssocName(env, db)
  const noun = isInvite ? await resolveOrgNounFromDb(db) : undefined
  const orgPhrase = assocName ? escHtml(assocName) : `your ${escHtml(noun ?? '')}`

  // Hand-written plain-text part (the html auto-derive would say "click the
  // button below" — wrong with no button). This is the login path, so keep the
  // URL prominent for text-only clients.
  const text = isInvite
    ? `You've been added to ${assocName ?? `your ${noun}`} on ${PRODUCT_NAME}, a legislative tracking tool. Set up your account:\n\n${magicLinkUrl}\n\nThis link expires in 7 days and can only be used once. You can also request a new sign-in link anytime using this email address:\n\n${env.APP_URL}\n\nIf you didn't expect this email, you can safely ignore it.`
    : `You requested a sign-in link for ${PRODUCT_NAME}. Open this link to access your account:\n\n${magicLinkUrl}\n\nThis link expires in 1 hour and can only be used once. If you didn't expect this email, you can safely ignore it.`

  const { subject, html } = renderMagicLinkEmail({ type, magicLinkUrl, appUrl: env.APP_URL, instanceName: assocName ?? '', orgPhrase })

  const r = await sendEmail(env, { to: [to], subject, html, text }, db)
  if (db) {
    let event: 'email_sent' | 'email_send_failed' | 'email_bounced' = 'email_sent'
    if (!r.ok) {
      // E_RECIPIENT_SUPPRESSED = address previously hard-bounced or was reported as
      // spam, so it's effectively a bounce; everything else is a send failure.
      // Note: this is the Cloudflare-binding path. Resend's r.error is just an HTTP
      // status string, so Resend failures always map to email_send_failed (Resend
      // doesn't surface suppression synchronously) — bounces there would come via Phase 2.
      event = r.error?.includes('E_RECIPIENT_SUPPRESSED') ? 'email_bounced' : 'email_send_failed'
    }
    await recordAuthEvent(db, {
      event, email: to, userId: userId ?? null, reason: r.error ?? null,
      linkType: type, provider: r.provider, messageId: r.messageId ?? null,
    })
  }
  if (!r.ok) throw new Error(`Email send failed (${r.provider}): ${r.error}`)
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
  if (!r.ok) throw new Error(`Email send failed (${r.provider}): ${r.error}`)
}
