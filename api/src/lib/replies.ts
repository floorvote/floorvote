// Reply notifications: a new comment notifies the bill's other participants.
//
// A participant is a member with a non-deleted comment on the bill or another
// bill in its companion group. Voting, writing a private note, reacting, and
// being mentioned do not make anyone one. The fan-out runs on create only, so
// editing a comment never notifies. The bill page decides whether to offer Mute
// with the same rule (`isReplyParticipant`) plus the member's setting, so the
// control and the notifications agree.
//
// A member's "Replies on bills you've commented on" setting
// (`users.emailRepliesEnabled`) governs the whole fan-out: a member with it off
// gets no reply notification in the app and no reply email, on any bill.
// Mentions are separate and unchanged: a mention always arrives in the app, and
// its email is gated only by the instance's conversation emails.
//
// Each remaining participant gets a `reply` notification in the app, and one
// email unless an admin turned conversation emails off for the instance. The
// email goes out from the request, like mention emails, with threading headers
// keyed to the bill so a bill's replies group into one conversation in a mail
// client.
//
// A member who muted the bill (#355) gets neither. Each reply email carries a
// one-click List-Unsubscribe and a footer link, both signed for that member and
// bill, that mute it.
import { and, eq, exists, isNull, ne, notExists, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client'
import { users, bills, sessions, comments, billMutes } from '../db/schema'
import { writeNotifications } from './notifications'
import { mentionEmailsEnabled, tiptapToEmailHtml } from './mentions'
import { sendBatch, resolveAssocName, type EmailMessage } from './email'
import { activeUser } from './accountDeletion'
import { muteLinkTokens } from './billMutes'
import { displayName } from './displayName'
import { inGroupOf } from './companionGroups'
import { billUrl } from '../../../shared/sessionSlug'
import { PRODUCT_NAME } from '../../../shared/brand'
import { buildBillCardModel } from '../../../shared/billCardModel'
import { renderBillCardOpen, BILL_CARD_CLOSE, renderCommentRow, formatEmailDateTime } from './emailBillCard'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'
import { fontWeight } from '../../../shared/tokens'
import { userTitleSql } from './userTitle'

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

type Participant = { id: string; email: string }

/**
 * The comment rows that make their author a reply participant: live comments on
 * the bill or any bill in its companion group, which is one conversation. The
 * one place the rule lives, shared by the fan-out and the bill page's Mute
 * control.
 */
function participantComments(billId: string): SQL {
  return and(inGroupOf(comments.billId, billId), isNull(comments.deletedAt))!
}

/**
 * Whether the member would get reply notifications for the bill's conversation:
 * they have a live comment on the bill or in its companion group. A mute, their
 * reply setting, and who wrote the next comment don't change it, so the bill
 * page checks the setting itself before it offers Mute to a participant.
 */
export async function isReplyParticipant(db: Db, userId: string, billId: string): Promise<boolean> {
  const row = await db.select({ id: comments.id }).from(comments)
    .where(and(eq(comments.userId, userId), participantComments(billId))).limit(1).get()
  return !!row
}

/**
 * The members to notify about a new comment: everyone else with a live comment
 * on the bill or another bill in its companion group, minus the author and
 * anyone who muted any bill in the group or turned their reply setting off.
 * Deactivated members and members without a login session are skipped, as role
 * mentions skip them. The caller removes anyone the comment mentions.
 */
async function replyRecipients(db: Db, billId: string, authorUserId: string): Promise<Participant[]> {
  const rows = await db
    .selectDistinct({ id: users.id, email: users.email })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(and(
      // A companion group is one conversation, so its participants are everyone
      // who commented on any of its bills.
      participantComments(billId),
      ne(users.id, authorUserId),
      // The member's "Replies on bills you've commented on" setting covers the
      // app as well as email. A mention doesn't come through here.
      eq(users.emailRepliesEnabled, 1),
      activeUser,
      exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))),
      // A mute on any bill in the group silences the whole conversation.
      notExists(db.select({ userId: billMutes.userId }).from(billMutes).where(and(eq(billMutes.userId, users.id), inGroupOf(billMutes.billId, billId)))),
    ))
    .all()
  return rows
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
  // Members who muted the bill or turned their reply setting off were already
  // left out of `recipients`, so both silence the app as well as the email.
  const written = await writeNotifications(db, recipients.map(p => ({
    recipientId: p.id,
    kind: 'reply',
    billId,
    commentId: comment.id,
    actorId: authorUserId,
    data: {},
  })))

  const toEmail = recipients.filter(p => written.has(p.id))
  if (toEmail.length === 0 || !(await mentionEmailsEnabled(db))) return

  const emailTask = sendReplyEmails(db, toEmail, comment, authorUserId, billId, env)
  if (waitUntil) waitUntil(emailTask)
  else emailTask.catch(() => {})
}

export interface ReplyEmailInput {
  appUrl: string
  author: { name: string; title: string | null }
  bill: {
    id: string; billNumber: string; title: string
    isDraft?: boolean
    state: string | null; session: string; sessionSlug?: string | null
    priority: 'high' | 'medium' | 'low' | null
    tenantSummary: string | null
  }
  comment: { id: string; createdAt: string; html: string }
  instanceName: string
  /** The recipient's signed "Mute this bill" page link (muteBillPageUrl). */
  muteUrl: string
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Renders the reply email. Pure, like renderMentionEmail, whose card it shares. */
export function renderReplyEmail(input: ReplyEmailInput): string {
  const { appUrl, author, bill, comment, instanceName, muteUrl } = input
  const model = buildBillCardModel({
    key: bill.id, billId: bill.id, billNumber: bill.billNumber, billTitle: bill.title,
    billSessionSlug: null, billState: bill.state, billSummary: bill.tenantSummary ?? null,
    billPriority: bill.priority, billMatchType: null, billIsDraft: bill.isDraft ?? false, date: '', events: [],
  })
  const billHref = `${appUrl}${billUrl({ id: bill.id, state: bill.state, session: bill.session, sessionSlug: bill.sessionSlug, billNumber: bill.billNumber })}`
  const commentRow = renderCommentRow({
    appUrl, name: author.name, title: author.title,
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
    footerHtml: [
      emailFooterLink(escHtml(muteUrl), 'Mute this bill'),
      emailFooterLink(escHtml(`${appUrl}/profile#setting-email-replies`), 'Turn off reply emails'),
      emailFooterLink(escHtml(appUrl), PRODUCT_NAME),
    ].join(' &nbsp;·&nbsp; '),
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

/**
 * The page a reply email's "Mute this bill" footer link opens. It asks before
 * muting, so a mail scanner that follows the link mutes nothing.
 */
export function muteBillPageUrl(appUrl: string, token: string): string {
  return `${appUrl}/mute-bill?token=${encodeURIComponent(token)}`
}

/**
 * One-click unsubscribe headers (RFC 8058) that mute the bill: a mail client's
 * Unsubscribe button posts to the URL with no session. Cloudflare Email Service
 * rejects the whole send when List-Unsubscribe is not https, so an instance on
 * plain http (local dev) gets none, and keeps the footer link.
 */
export function muteUnsubscribeHeaders(appUrl: string, token: string): Record<string, string> {
  if (!appUrl.startsWith('https://')) return {}
  return {
    'List-Unsubscribe': `<${appUrl}/api/mute-link?token=${encodeURIComponent(token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
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
    .select({ name: users.name, email: users.email, title: userTitleSql })
    .from(users).where(eq(users.id, authorUserId)).all()
  const [bill] = await db
    .select({
      id: bills.id, billNumber: bills.billNumber, title: bills.title, isDraft: bills.isDraft,
      state: bills.state, session: bills.session, sessionSlug: bills.sessionSlug, priority: bills.priority, tenantSummary: bills.tenantSummary,
    })
    .from(bills).where(eq(bills.id, billId)).all()
  if (!author || !bill) return

  const instanceName = (await resolveAssocName(env, db)) ?? ''
  // One subject per bill, so replies group even in clients that thread on it.
  const subject = `[${bill.billNumber}] New comment`
  const threadHeaders = replyThreadHeaders(env.APP_URL, billId)

  // Each recipient's email differs only in its mute links, which are signed for them.
  const muteLinkToken = await muteLinkTokens(db)
  const messages: EmailMessage[] = await Promise.all(recipients.map(async (p): Promise<EmailMessage> => {
    const token = await muteLinkToken(p.id, billId)
    const html = renderReplyEmail({
      appUrl: env.APP_URL,
      author: { name: displayName(author), title: author.title },
      bill,
      comment,
      instanceName,
      muteUrl: muteBillPageUrl(env.APP_URL, token),
    })
    return { to: [p.email], subject, html, headers: { ...threadHeaders, ...muteUnsubscribeHeaders(env.APP_URL, token) } }
  }))
  console.log(`[replies] sending email to ${messages.length} recipient(s) for bill ${bill.billNumber}`)
  await sendBatch(env, messages, `replies ${bill.billNumber}`, db)
}
