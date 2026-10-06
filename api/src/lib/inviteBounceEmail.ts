import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Env, AppDb } from '../types'
import { users } from '../db/schema'
import { color, fontSize, fontWeight, radius, shadow } from '../../../shared/tokens'
import { PRODUCT_NAME } from '../../../shared/brand'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'
import { sendEmail, resolveAssocName } from './email'
import type { RecordedBounce } from './inviteBounces'
import { normalizeMemberAddress } from './memberAddress'

/** One bounced address as the email lists it. */
export type BouncedAddress = { email: string; reason: string }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Members, with the search box pre-filled when exactly one address bounced, so
 * the admin lands on that row. Several addresses link to Members unfiltered.
 */
export function bounceMembersUrl(appUrl: string, addresses: string[]): string {
  const base = `${appUrl}/admin/members`
  return addresses.length === 1 ? `${base}?search=${encodeURIComponent(addresses[0])}` : base
}

/**
 * Pure renderer for the bounced-invite email. Shared by the hourly notification
 * and the sample registry so the real and sample emails can't drift.
 */
export function renderInviteBounceEmail(input: {
  appUrl: string
  instanceName: string
  bounces: BouncedAddress[]
}): { subject: string; html: string; text: string } {
  const n = input.bounces.length
  const one = n === 1
  const subject = one ? "An invite couldn't be delivered" : `${n} invites couldn't be delivered`
  const href = bounceMembersUrl(input.appUrl, input.bounces.map(b => b.email))

  const intro = one
    ? "This invite bounced at the receiving mail server, so it never arrived. The reason the server gave is below."
    : "These invites bounced at the receiving mail servers, so they never arrived. The reason each server gave is below."
  const advice = one
    ? "Check the address for a typo. On Members, open that member's Actions menu and choose Change email… to send a new invite to the corrected address."
    : "Check each address for a typo. On Members, open each member's Actions menu and choose Change email… to send a new invite to the corrected address."

  const rows = input.bounces.map((b, i) => `
      <tr><td style="padding:12px 16px;${i > 0 ? `border-top:1px solid ${color.borderDefault};` : ''}">
        <p style="margin:0;font-size:${fontSize.base}px;font-weight:${fontWeight.semibold};color:${color.textPrimary};word-break:break-all;">${esc(b.email)}</p>
        <p style="margin:4px 0 0;font-size:${fontSize.sm}px;line-height:1.5;color:${color.textSecondary};word-break:break-word;">${esc(b.reason)}</p>
      </td></tr>`).join('')

  const html = renderEmailShell({
    instanceName: input.instanceName,
    appUrl: input.appUrl,
    signalHtml: subject,
    bodyHtml: `
      <p style="margin:0 0 14px;font-size:${fontSize.base}px;line-height:1.6;color:${color.textSlate};">${intro}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${color.white};border:1px solid ${color.borderDefault};border-radius:${radius.lg}px;box-shadow:${shadow.sm};">
        <tbody>${rows}
        </tbody>
      </table>
      <p style="margin:14px 0 0;font-size:${fontSize.base}px;line-height:1.6;color:${color.textSlate};">${advice}</p>`,
    ctaHtml: emailButton(esc(href), 'Open Members'),
    footerHtml: `<p style="margin:0 0 8px;font-size:${fontSize.sm}px;line-height:1.5;color:${color.textMuted};">Sent to the Admin who sent the invite, or to every Owner when that Admin no longer manages members.</p>${emailFooterLink(esc(input.appUrl), PRODUCT_NAME)}`,
  })

  // Hand-written so the link and each reason read cleanly without the HTML.
  const text = [
    intro,
    '',
    ...input.bounces.flatMap(b => [b.email, `  ${b.reason}`, '']),
    advice,
    '',
    `Open Members: ${href}`,
  ].join('\n')

  return { subject, html, text }
}

type Recipient = { id: string; email: string; bounces: BouncedAddress[] }

/**
 * Who hears about each bounce: the inviter while they are an active Admin or
 * Owner, otherwise (deactivated, or demoted to Standard member) every active
 * Owner. Every bounce has an inviter: the check only covers pending invites.
 * Grouped so each recipient gets one email
 * for the run, and an address bounced twice in one run (its invite and a
 * sign-in link) is listed once.
 */
async function routeBounces(db: AppDb, bounces: RecordedBounce[]): Promise<Recipient[]> {
  const inviterIds = [...new Set(bounces.map(b => b.inviterId))]
  const inviters = await db
    .select({ id: users.id, email: users.email, role: users.role, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(inArray(users.id, inviterIds))
    .all()
  const activeAdmin = new Map(inviters
    .filter(u => !u.deactivatedAt && (u.role === 'admin' || u.role === 'owner'))
    .map(u => [u.id, u]))

  let owners: { id: string; email: string }[] | null = null
  const recipients = new Map<string, Recipient>()
  const add = (r: { id: string; email: string }, b: RecordedBounce) => {
    const entry = recipients.get(r.id) ?? { id: r.id, email: r.email, bounces: [] }
    if (!entry.bounces.some(x => normalizeMemberAddress(x.email) === normalizeMemberAddress(b.email))) {
      entry.bounces.push({ email: b.email, reason: b.reason })
    }
    recipients.set(r.id, entry)
  }

  for (const b of bounces) {
    const inviter = activeAdmin.get(b.inviterId)
    if (inviter) { add(inviter, b); continue }
    owners ??= await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.role, 'owner'), isNull(users.deactivatedAt)))
      .all()
    if (owners.length === 0) console.warn(`[invite-bounces] no active Owner to notify about a bounce for member ${b.memberId}`)
    for (const o of owners) add(o, b)
  }
  return [...recipients.values()]
}

/**
 * Email the bounces one hourly run recorded: one email per recipient, listing
 * each bounced address with the receiving server's reason. Transactional, so
 * there is no opt-out. Called only with bounces the run newly recorded, so a
 * bounce is notified once; a failed send is logged and not retried, because the
 * recorded bounce already marks it handled. Never throws.
 */
export async function notifyInviteBounces(env: Env, db: AppDb, bounces: RecordedBounce[]): Promise<void> {
  if (bounces.length === 0) return
  let recipients: Recipient[]
  let instanceName: string
  try {
    recipients = await routeBounces(db, bounces)
    instanceName = (await resolveAssocName(env, db)) ?? ''
  } catch (err) {
    console.error('[invite-bounces] could not prepare the bounce notification', err)
    return
  }
  for (const r of recipients) {
    const { subject, html, text } = renderInviteBounceEmail({ appUrl: env.APP_URL, instanceName, bounces: r.bounces })
    try {
      const res = await sendEmail(env, { to: [r.email], subject, html, text }, db)
      if (!res.ok) console.error(`[invite-bounces] bounce notification to member ${r.id} failed (${res.provider}): ${res.error}`)
    } catch (err) {
      console.error(`[invite-bounces] bounce notification to member ${r.id} failed`, err)
    }
  }
}
