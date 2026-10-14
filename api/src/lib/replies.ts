// Reply notifications: a new comment notifies the bill's other participants.
//
// A participant is a member with a non-deleted comment on the bill. Voting,
// writing a private note, and being mentioned do not make anyone one. The
// fan-out runs on create only, so editing a comment never notifies.
//
// Each participant gets a `reply` notification in the app, and one email unless
// they turned reply emails off or an admin turned conversation emails off for
// the instance. The email goes out from the request, like mention emails, with
// threading headers keyed to the bill so a bill's replies group into one
// conversation in a mail client.
import { and, eq, exists, isNull, ne } from 'drizzle-orm'
import { getDb } from '../db/client'
import { users, bills, sessions, comments } from '../db/schema'
import { writeNotifications } from './notifications'
import { mentionEmailsEnabled, tiptapToEmailHtml } from './mentions'
import { sendBatch, resolveAssocName, type EmailMessage } from './email'
import { activeUser } from './accountDeletion'
import { displayName } from './displayName'
import { inGroupOf } from './companionGroups'
import { billUrl } from '../../../shared/sessionSlug'
import { PRODUCT_NAME } from '../../../shared/brand'
import { buildBillCardModel } from '../../../shared/billCardModel'
import { renderBillCardOpen, BILL_CARD_CLOSE, renderCommentRow, formatEmailDateTime } from './emailBillCard'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'
import { fontWeight } from '../../../shared/tokens'

type Db = ReturnType<typeof getDb>

interface ReplyEnv {
  DB: D1Database
  RESEND_API_KEY: string
  APP_URL: string
  DEMO_MODE?: string
  EMAIL_PROVIDER?: string
  EMAIL?: import('./email').CloudflareEmailBinding
  ASSOCIATION_NAME?: string
}

type Participant = { id: string; email: string; emailReplies: boolean }

/**
 * The members to notify about a new comment: everyone else with a live comment
 * on the bill or another bill in its companion group, minus the author. Deactivated members and members without a
 * login session are skipped, as role mentions skip them. The caller removes
 * anyone the comment mentions.
 */
async function replyRecipients(db: Db, billId: string, authorUserId: string): Promise<Participant[]> {
  const rows = await db
    .selectDistinct({ id: users.id, email: users.email, emailReplies: users.emailRepliesEnabled })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(and(
      // A companion group is one conversation, so its participants are everyone
      // who commented on any of its bills.
      inGroupOf(comments.billId, billId),
      isNull(comments.deletedAt),
      ne(users.id, authorUserId),
      activeUser,
      exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))),
    ))
    .all()
  return rows.map(r => ({ id: r.id, email: r.email, emailReplies: r.emailReplies === 1 }))
}

/**
 * Create path: notify the bill's other participants of a new comment, and email
 * those who want it. `mentionedUserIds` are the people the same comment
 * mentions. They get the mention instead, so they are left out here.
 */
export async function notifyParticipantsOfReply(
  comment: { id: string; html: string; createdAt: string },
  authorUserId: string,
  billId: string,
  mentionedUserIds: readonly string[],
  env: ReplyEnv,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
  const db = getDb(env.DB)
  const mentioned = new Set(mentionedUserIds)
  const recipients = (await replyRecipients(db, billId, authorUserId)).filter(p => !mentioned.has(p.id))
  if (recipients.length === 0) return

  // writeNotifications splits the rows to stay under D1's parameter limit and
  // reports who was actually written, so a retried fan-out emails nobody twice.
  // (Per-bill mute, #355, will drop recipients who muted the bill just above
  // this, so mute silences the app as well as the email.)
  const written = await writeNotifications(db, recipients.map(p => ({
    recipientId: p.id,
    kind: 'reply',
    billId,
    commentId: comment.id,
    actorId: authorUserId,
    data: {},
  })))

  const toEmail = recipients.filter(p => written.has(p.id) && p.emailReplies)
  if (toEmail.length === 0 || !(await mentionEmailsEnabled(db))) return

  const emailTask = sendReplyEmails(db, toEmail, comment, authorUserId, billId, env)
  if (waitUntil) waitUntil(emailTask)
  else emailTask.catch(() => {})
}

export interface ReplyEmailInput {
  appUrl: string
  author: { name: string; subtitle: string | null }
  bill: {
    id: string; billNumber: string; title: string
    isDraft?: boolean
    state: string | null; session: string; sessionSlug?: string | null
    priority: 'high' | 'medium' | 'low' | null
    tenantSummary: string | null
  }
  comment: { id: string; createdAt: string; html: string }
  instanceName: string
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Renders the reply email. Pure, like renderMentionEmail, whose card it shares. */
export function renderReplyEmail(input: ReplyEmailInput): string {
  const { appUrl, author, bill, comment, instanceName } = input
  const model = buildBillCardModel({
    key: bill.id, billId: bill.id, billNumber: bill.billNumber, billTitle: bill.title,
    billSessionSlug: null, billState: bill.state, billSummary: bill.tenantSummary ?? null,
    billPriority: bill.priority, billMatchType: null, billIsDraft: bill.isDraft ?? false, date: '', events: [],
  })
  const billHref = `${appUrl}${billUrl({ id: bill.id, state: bill.state, session: bill.session, sessionSlug: bill.sessionSlug, billNumber: bill.billNumber })}`
  const commentRow = renderCommentRow({
    appUrl, name: author.name, subtitle: author.subtitle,
    dateText: formatEmailDateTime(comment.createdAt),
    bodyHtml: tiptapToEmailHtml(comment.html),
  })
  const card = `${renderBillCardOpen({ model, billHref, appUrl })}
    ${commentRow}${BILL_CARD_CLOSE}`
  const strong = (s: string) => `<strong style="font-weight:${fontWeight.semibold};">${s}</strong>`

  return renderEmailShell({
    instanceName,
    appUrl,
    signalHtml: `${strong(escHtml(author.name))} commented on a bill you've commented on`,
    dateLabel: formatEmailDateTime(comment.createdAt),
    bodyHtml: card,
    ctaHtml: emailButton(escHtml(`${billHref}#comment-${comment.id}`), 'View comment'),
    // Per-bill mute (#355) adds its link here, beside this one.
    footerHtml: `${emailFooterLink(escHtml(`${appUrl}/profile#setting-email-replies`), 'Turn off reply emails')} &nbsp;·&nbsp; ${emailFooterLink(escHtml(appUrl), PRODUCT_NAME)}`,
  })
}

/**
 * Headers that group a bill's reply emails into one conversation: every email
 * on a bill references one shared, bill-keyed id, so a mail client threads them
 * (together with the constant subject) even though no message with that id
 * exists. Message-ID is deliberately not set. Cloudflare Email Service controls
 * it and rejects the whole send with E_HEADER_NOT_ALLOWED if it is present.
 */
export function replyThreadHeaders(appUrl: string, billId: string): Record<string, string> {
  // The id-left part must be dot-atom text, and bill ids are not guaranteed to
  // be, so anything else becomes an underscore.
  const root = `<bill-${billId.replace(/[^A-Za-z0-9._-]/g, '_')}@${new URL(appUrl).hostname}>`
  return { 'In-Reply-To': root, 'References': root }
}

async function sendReplyEmails(
  db: Db,
  recipients: Participant[],
  comment: { id: string; html: string; createdAt: string },
  authorUserId: string,
  billId: string,
  env: ReplyEnv,
): Promise<void> {
  const [author] = await db
    .select({ name: users.name, email: users.email, subtitle: users.subtitle })
    .from(users).where(eq(users.id, authorUserId)).all()
  const [bill] = await db
    .select({
      id: bills.id, billNumber: bills.billNumber, title: bills.title, isDraft: bills.isDraft,
      state: bills.state, session: bills.session, sessionSlug: bills.sessionSlug, priority: bills.priority, tenantSummary: bills.tenantSummary,
    })
    .from(bills).where(eq(bills.id, billId)).all()
  if (!author || !bill) return

  const instanceName = (await resolveAssocName(env, db)) ?? ''
  const html = renderReplyEmail({
    appUrl: env.APP_URL,
    author: { name: displayName(author), subtitle: author.subtitle },
    bill,
    comment,
    instanceName,
  })
  // One subject per bill, so replies group even in clients that thread on it.
  const subject = `[${bill.billNumber}] New comment`
  const headers = replyThreadHeaders(env.APP_URL, billId)

  const messages: EmailMessage[] = recipients.map(p => ({ to: [p.email], subject, html, headers }))
  console.log(`[replies] sending email to ${messages.length} recipient(s) for bill ${bill.billNumber}`)
  await sendBatch(env, messages, `replies ${bill.billNumber}`, db)
}
