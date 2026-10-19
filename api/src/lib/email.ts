import { eq, inArray } from 'drizzle-orm'
import type { Env, AppDb } from '../types'
import { associationConfig } from '../db/schema'
import { createSender, type EmailSender, type SenderEnv, type SignInMessage } from '../../../shared/emailSender'
import type { ProviderName, CloudflareEmailBinding } from '../../../shared/emailProviders'
import { emailHealthRecorder } from './emailHealthRecorder'
import { resolveOrgNoun as _resolveOrgNoun } from '../../../shared/orgNoun'
import { PRODUCT_NAME } from '../../../shared/brand'
import { color, fontSize } from '../../../shared/tokens'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'

// Every email the API sends goes through the shared purpose-level sender
// (shared/emailSender.ts, #705): a caller names the email's purpose and the
// sender decides fallback, health counting, the From address, and demo mode.
// `senderFor` is the one way in. This module also holds what is specific to the
// API's mail: the shared shell and wordmark, the org name and noun read from
// config, and the sign-in message.

/**
 * The shared sender for the API. With a `db`, every attempt of a purpose that
 * counts goes to email health (`email_send_stats` and the Resend usage
 * readout). Without one, nothing is counted.
 */
export function senderFor(env: SenderEnv, db?: AppDb): EmailSender {
  return createSender(env, { recorder: db ? emailHealthRecorder(db) : undefined })
}

export type { ProviderName, CloudflareEmailBinding }

/**
 * RFC-2369 List-Unsubscribe header for recurring mail (digest, week-ahead),
 * pointing at the in-app opt-out the recipient already controls
 * (`/profile#<anchor>`). Improves bulk deliverability; no new endpoint needed.
 */
export function unsubscribeHeaders(appUrl: string, anchor: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${appUrl}/profile#${anchor}>` }
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
export async function resolveOrgNounFromDb(db?: AppDb): Promise<string> {
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

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Pure renderer for the magic-link (login/invite) email. Shared by buildSignInMessage
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
