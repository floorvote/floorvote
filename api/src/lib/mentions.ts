import { getDb } from '../db/client'
import { notifications, type MentionNotificationData, userRoles, users, bills, roles, sessions, associationConfig, comments } from '../db/schema'
import { writeNotifications, mentionData } from './notifications'
import { chunk, D1_MAX_PARAMS } from './chunk'
import { eq, inArray, exists, and } from 'drizzle-orm'
import { activeUser } from './accountDeletion'
import { billUrl } from '../../../shared/sessionSlug'
import { PRODUCT_NAME } from '../../../shared/brand'
import { senderFor, resolveAssocName } from './email'
import type { NotificationMessage } from '../../../shared/emailSender'
import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
import { buildBillCardModel } from '../../../shared/billCardModel'
import { MENTION_STYLE } from '../../../shared/mentionStyle'
import { renderBillCardOpen, BILL_CARD_CLOSE, renderCommentRow, formatEmailDateTime } from './emailBillCard'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'
import { sanitizeCommentHtml } from './sanitizeHtml'
import { displayName } from './displayName'
import { userTitleSql } from './userTitle'

/** @mention emails are on unless an admin explicitly disabled them. */
export async function mentionEmailsEnabled(db: ReturnType<typeof getDb>): Promise<boolean> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'mention_emails_enabled')).get()
  if (!row) return true
  try { return JSON.parse(row.value) !== false } catch { return true }
}

type Mention = {
  type: 'user' | 'role' | 'admins' | 'everyone'
  id: string
  label: string
}

export function extractMentions(html: string): Mention[] {
  if (!html) return []

  const mentions: Mention[] = []
  const seen = new Set<string>()
  const spanPattern = /<span[^>]*data-type="mention"[^>]*>/g
  let match: RegExpExecArray | null

  while ((match = spanPattern.exec(html)) !== null) {
    const span = match[0]
    const idMatch = span.match(/data-id="(user|role|admins|everyone):([^"]+)"/)
    const labelMatch = span.match(/data-label="([^"]+)"/)
    if (idMatch && labelMatch) {
      const key = `${idMatch[1]}:${idMatch[2]}`
      if (!seen.has(key)) {
        seen.add(key)
        mentions.push({
          type: idMatch[1] as 'user' | 'role' | 'admins' | 'everyone',
          id: idMatch[2],
          label: labelMatch[1],
        })
      }
    }
  }

  // Handle attributes in different order (data-id before data-type)
  const altPattern = /<span[^>]*data-id="(user|role|admins|everyone):([^"]+)"[^>]*data-type="mention"[^>]*>/g
  while ((match = altPattern.exec(html)) !== null) {
    const key = `${match[1]}:${match[2]}`
    if (seen.has(key)) continue
    const span = match[0]
    const labelMatch = span.match(/data-label="([^"]+)"/)
    if (labelMatch) {
      seen.add(key)
      mentions.push({
        type: match[1] as 'user' | 'role' | 'admins' | 'everyone',
        id: match[2],
        label: labelMatch[1],
      })
    }
  }

  return mentions
}


function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function tiptapToEmailHtml(rawHtml: string): string {
  // Defensively sanitize first: comment content is stored sanitized on write
  // (H5), but this restyling pass otherwise passes any unknown tag/attribute
  // through unescaped, so we re-apply the allowlist here too (defense in depth).
  // Sanitization preserves the known tiptap tags + mention spans the styling
  // replacements below target.
  const html = sanitizeCommentHtml(rawHtml)
  return html
    .replace(/<p>/g, '<p style="margin:0 0 12px;line-height:1.6;color:#334155;">')
    .replace(/<strong>/g, '<strong style="font-weight:600;color:#0f172a;">')
    .replace(/<em>/g, '<em style="font-style:italic;">')
    .replace(/<s>/g, '<s style="text-decoration:line-through;color:#64748b;">')
    .replace(/<code>/g, '<code style="background:#f1f5f9;color:#0f172a;padding:1px 4px;border-radius:3px;font-size:13px;font-family:monospace;">')
    .replace(/<blockquote>/g, '<blockquote style="border-left:3px solid #cbd5e1;margin:0 0 12px;padding:4px 12px;color:#64748b;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 12px;padding-left:20px;color:#334155;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 12px;padding-left:20px;color:#334155;">')
    .replace(/<li>/g, '<li style="margin-bottom:4px;line-height:1.6;">')
    .replace(
      /<span[^>]+data-type="mention"[^>]+>([^<]+)<\/span>/g,
      (match, label) => {
        // label is already HTML-encoded by TipTap — use as-is, no double-escaping.
        // Colours come from the shared MENTION_STYLE so the email can't drift from
        // the app (role = indigo, user = gray). See shared/mentionStyle.ts.
        const isGroup = match.includes('data-id="role:') || match.includes('data-id="admins:') || match.includes('data-id="everyone:')
        const pill = isGroup ? MENTION_STYLE.role : MENTION_STYLE.user
        const rad = isGroup ? '99px' : '4px'
        const pad = isGroup ? '2px 8px' : '1px 6px'
        return `<span style="background:${pill.bg};color:${pill.text};padding:${pad};border-radius:${rad};font-weight:${MENTION_STYLE.weight};">${label}</span>`
      },
    )
}

export interface MentionEmailInput {
  appUrl: string
  author: { name: string; title: string | null }
  bill: {
    id: string; billNumber: string; title: string
    /** Lets the card label an untitled draft "Untitled draft". Absent = filed. */
    isDraft?: boolean
    state: string | null; session: string
    /** The slug central assigned the bill's session. Absent = computed from `session`. */
    sessionSlug?: string | null
    priority: 'high' | 'medium' | 'low' | null
    tenantSummary: string | null
  }
  comment: { id: string; createdAt: string; html: string }
  via: 'user' | 'role' | 'admins' | 'everyone'
  roleName?: string | null
  instanceName: string
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// Renders the @-mention notification email. Pure (no DB/env) so it's unit-testable
// and mirrors renderDigestEmail / renderWeekAheadEmail. The bill renders with the
// shared bill-card (renderBillCardOpen) and the comment sits inside it as a card
// row (renderCommentRow) — a Feed / BillDetail hybrid — wrapped in the digest's
// gray shell.
export function renderMentionEmail(input: MentionEmailInput): string {
  const { appUrl, author, bill, comment, via, roleName, instanceName } = input
  const model = buildBillCardModel({
    key: bill.id, billId: bill.id, billNumber: bill.billNumber, billTitle: bill.title,
    billSessionSlug: null, billState: bill.state, billSummary: bill.tenantSummary ?? null,
    billPriority: bill.priority, billMatchType: null, billIsDraft: bill.isDraft ?? false, date: '', events: [],
  })
  const billHref = `${appUrl}${billUrl({ id: bill.id, state: bill.state, session: bill.session, sessionSlug: bill.sessionSlug, billNumber: bill.billNumber })}`
  const commentUrl = `${billHref}#comment-${comment.id}`
  const title = author.title ? truncate(author.title, 60) : null
  const commentRow = renderCommentRow({
    appUrl, name: author.name, title,
    dateText: formatEmailDateTime(comment.createdAt),
    bodyHtml: tiptapToEmailHtml(comment.html),
  })
  const card = `${renderBillCardOpen({ model, billHref, appUrl })}
    ${commentRow}${BILL_CARD_CLOSE}`

  const authorName = escHtml(author.name)
  const strong = (s: string) => `<strong style="font-weight:${fontWeight.semibold};">${s}</strong>`
  const intro = via === 'everyone'
    ? `${strong(authorName)} notified everyone in a comment`
    : via === 'admins'
      ? `${strong(authorName)} mentioned ${strong('@admins')} in a comment`
    : (via === 'role' && roleName)
      ? `${strong(authorName)} mentioned ${strong(`@${escHtml(roleName)}`)} in a comment`
      : `${strong(authorName)} mentioned you in a comment`

  const roleNote = (via === 'role' && roleName)
    ? `<p style="margin:0 0 20px;font-size:${fontSize.sm}px;color:${color.textSecondary};">You're receiving this because your account has the <span style="font-size:${fontSize.xs}px;font-weight:${fontWeight.medium};color:${MENTION_STYLE.role.text};background:${MENTION_STYLE.role.bg};border-radius:${radius.pill}px;padding:3px 9px;display:inline-block;white-space:nowrap;">${escHtml(roleName)}</span> role.</p>`
    : ''
  const adminsNote = via === 'admins'
    ? `<p style="margin:0 0 20px;font-size:${fontSize.sm}px;color:${color.textSecondary};">You're receiving this because you're an admin.</p>`
    : ''
  const everyoneNote = via === 'everyone'
    ? `<p style="margin:0 0 20px;font-size:${fontSize.sm}px;color:${color.textSecondary};">You're receiving this because an admin notified everyone.</p>`
    : ''

  return renderEmailShell({
    instanceName,
    appUrl,
    signalHtml: intro,
    dateLabel: formatEmailDateTime(comment.createdAt),
    bodyHtml: `${card}${roleNote}${adminsNote}${everyoneNote}`,
    ctaHtml: emailButton(escHtml(commentUrl), 'View comment'),
    footerHtml: emailFooterLink(escHtml(appUrl), PRODUCT_NAME),
  })
}

interface MentionEnv {
  DB: D1Database
  RESEND_API_KEY: string
  APP_URL: string
  DEMO_MODE?: string
  EMAIL_PROVIDER?: string
  EMAIL?: import('./email').CloudflareEmailBinding
  ASSOCIATION_NAME?: string
}

type NotificationTarget = {
  userId: string
  via: 'user' | 'role' | 'admins' | 'everyone'
  roleName?: string
  /** What the mention record points at: the user, the role, or 'all' for @admins and @everyone. */
  sourceId: string
}

type Db = ReturnType<typeof getDb>

/**
 * Resolves a comment's mention spans to the people they reach, one target per
 * person. A person reached more than one way is attributed to the first that
 * applies: direct mention, then role, then @admins, then @everyone. The author
 * is never a target, @everyone only counts from an admin or owner (@admins
 * from anyone), and role, @admins, and @everyone expansion skips members
 * without a login session (invite-pending or deactivated).
 *
 * Both the create path and the edit diff resolve through here, so "who does this
 * comment reach" has one definition.
 */
async function resolveMentionTargets(
  db: Db,
  mentions: Mention[],
  authorUserId: string,
  authorRole: 'admin' | 'member' | 'owner',
): Promise<NotificationTarget[]> {
  if (mentions.length === 0) return []

  const targets = new Map<string, NotificationTarget>()

  for (const m of mentions) {
    if (m.type === 'user' && m.id !== authorUserId && !targets.has(m.id)) {
      targets.set(m.id, { userId: m.id, via: 'user', sourceId: m.id })
    }
  }

  const roleMentions = mentions.filter(m => m.type === 'role')
  if (roleMentions.length > 0) {
    const roleIds = roleMentions.map(m => m.id)

    const [roleRows, roleMembers] = await Promise.all([
      db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)).all(),
      db.select({ roleId: userRoles.roleId, userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(users, eq(userRoles.userId, users.id))
        .where(and(inArray(userRoles.roleId, roleIds), exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id)))))
        .all(),
    ])

    const roleNameMap = new Map(roleRows.map(r => [r.id, r.name]))
    console.log(`[mentions] role lookup: ${roleIds.length} role(s) [${roleIds.join(',')}], ${roleMembers.length} member(s) found`)

    for (const rm of roleMembers) {
      if (rm.userId !== authorUserId && !targets.has(rm.userId)) {
        targets.set(rm.userId, {
          userId: rm.userId,
          via: 'role',
          roleName: roleNameMap.get(rm.roleId),
          sourceId: rm.roleId,
        })
      }
    }
  }

  if (mentions.some(m => m.type === 'admins')) {
    const adminRows = await db.select({ id: users.id }).from(users)
      .where(and(
        inArray(users.role, ['admin', 'owner']),
        activeUser,
        exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))),
      ))
      .all()
    for (const a of adminRows) {
      if (a.id !== authorUserId && !targets.has(a.id)) {
        targets.set(a.id, { userId: a.id, via: 'admins', sourceId: 'all' })
      }
    }
  }

  const hasEveryone = mentions.some(m => m.type === 'everyone')
  if (hasEveryone && (authorRole === 'admin' || authorRole === 'owner')) {
    const allUsers = await db.select({ id: users.id }).from(users)
      .where(exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id))))
      .all()
    for (const u of allUsers) {
      if (u.id !== authorUserId && !targets.has(u.id)) {
        targets.set(u.id, { userId: u.id, via: 'everyone', sourceId: 'all' })
      }
    }
  }

  return [...targets.values()]
}

/**
 * Writes mention notifications for the given targets, then emails the people
 * actually written unless an admin turned mention emails off. A person who
 * already has a mention on this comment (a concurrent edit got there first) is
 * neither written nor emailed again.
 */
async function recordAndEmail(
  db: Db,
  newTargets: NotificationTarget[],
  commentId: string,
  html: string,
  authorUserId: string,
  billId: string,
  env: MentionEnv,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
  if (newTargets.length === 0) return

  const written = await writeNotifications(db, newTargets.map(t => ({
    recipientId: t.userId,
    kind: 'mention',
    billId,
    commentId,
    actorId: authorUserId,
    data: { sourceType: t.via, sourceId: t.sourceId },
  })))
  const toEmail = newTargets.filter(t => written.has(t.userId))

  if (toEmail.length > 0 && await mentionEmailsEnabled(db)) {
    const emailTask = sendMentionEmails(toEmail, authorUserId, billId, commentId, html, env)
    if (waitUntil) {
      waitUntil(emailTask)
    } else {
      emailTask.catch(() => {})
    }
  }
}

/** Create path: record a mention for, and email, everyone the new comment reaches. Returns their user ids. */
export async function extractAndNotifyMentions(
  commentId: string,
  html: string,
  authorUserId: string,
  authorRole: 'admin' | 'member' | 'owner',
  billId: string,
  env: MentionEnv,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<string[]> {
  const db = getDb(env.DB)
  const targets = await resolveMentionTargets(db, extractMentions(html), authorUserId, authorRole)
  await recordAndEmail(db, targets, commentId, html, authorUserId, billId, env, waitUntil)
  return targets.map(t => t.userId)
}

/** Repoints a mention notification at the token that now reaches its recipient. Read state is untouched. */
function setMentionSource(db: Db, id: string, data: MentionNotificationData) {
  return db.update(notifications).set({ data: JSON.stringify(data) }).where(eq(notifications.id, id))
}

/** A mention token: `user:<id>`, `role:<id>`, `admins`, or `everyone`. A record's source maps to the same form. */
function mentionToken(type: Mention['type'], id: string): string {
  return type === 'everyone' || type === 'admins' ? type : `${type}:${id}`
}

/**
 * Edit path: reconcile the comment's mention records with its new content instead
 * of starting over. Records are keyed by person (comment + user); each carries
 * the source token that reached them (a user, a role, or @everyone).
 *
 * The diff is on mention tokens, not on who a role contains today. Re-resolving a
 * role or @everyone on every edit would email people who joined the role after
 * the comment was posted and delete the records of people who have since left
 * it, so a typo fix could not leave things alone. Instead:
 *
 *   - Tokens unchanged: nothing is written and nobody is emailed.
 *   - A record whose source token is still present is kept as is, read state and
 *     all, without re-resolving it. The one exception is a person now mentioned
 *     directly, whose source flips to the user.
 *   - A record whose source token was removed is re-resolved against the
 *     remaining tokens: kept with its new source if still reached, otherwise
 *     deleted.
 *   - Added tokens are resolved, and only people with no record yet get one and
 *     an email. Someone already reached, directly or through a role, is not
 *     emailed again.
 *
 * Returns everyone the edited comment now reaches, kept and new.
 */
export async function syncMentionsOnEdit(
  commentId: string,
  previousHtml: string,
  html: string,
  authorUserId: string,
  authorRole: 'admin' | 'member' | 'owner',
  billId: string,
  env: MentionEnv,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<string[]> {
  const db = getDb(env.DB)
  const mentions = extractMentions(html)
  const tokens = new Set(mentions.map(m => mentionToken(m.type, m.id)))
  const previousTokens = new Set(extractMentions(previousHtml).map(m => mentionToken(m.type, m.id)))
  const existing = (await db
    .select({ id: notifications.id, userId: notifications.recipientId, data: notifications.data })
    .from(notifications)
    .where(and(eq(notifications.commentId, commentId), eq(notifications.kind, 'mention')))
    .all())
    .flatMap(r => {
      const data = mentionData(r.data)
      return data ? [{ id: r.id, userId: r.userId, ...data }] : []
    })

  const added = mentions.filter(m => !previousTokens.has(mentionToken(m.type, m.id)))
  const removed = [...previousTokens].some(t => !tokens.has(t))
  if (added.length === 0 && !removed) return existing.map(r => r.userId)

  // Only needed when some record's source token went away.
  const sourceGone = (r: (typeof existing)[number]) => !tokens.has(mentionToken(r.sourceType, r.sourceId))
  const remaining = existing.some(sourceGone)
    ? new Map((await resolveMentionTargets(db, mentions, authorUserId, authorRole)).map(t => [t.userId, t]))
    : new Map<string, NotificationTarget>()

  const reached = new Set<string>()
  const writes: unknown[] = []
  for (const row of existing) {
    if (tokens.has(`user:${row.userId}`) && row.sourceType !== 'user') {
      reached.add(row.userId)
      writes.push(setMentionSource(db, row.id, { sourceType: 'user', sourceId: row.userId }))
    } else if (!sourceGone(row)) {
      reached.add(row.userId)
    } else {
      const target = remaining.get(row.userId)
      if (!target) {
        writes.push(db.delete(notifications).where(eq(notifications.id, row.id)))
        continue
      }
      reached.add(row.userId)
      if (row.sourceType !== target.via || row.sourceId !== target.sourceId) {
        writes.push(setMentionSource(db, row.id, { sourceType: target.via, sourceId: target.sourceId }))
      }
    }
  }
  if (writes.length > 0) await db.batch(writes as unknown as Parameters<typeof db.batch>[0])

  const existingIds = new Set(existing.map(r => r.userId))
  const newcomers = (await resolveMentionTargets(db, added, authorUserId, authorRole))
    .filter(t => !existingIds.has(t.userId))
  await recordAndEmail(db, newcomers, commentId, html, authorUserId, billId, env, waitUntil)
  return [...reached, ...newcomers.map(t => t.userId)]
}

async function sendMentionEmails(
  targets: NotificationTarget[],
  authorUserId: string,
  billId: string,
  commentId: string,
  html: string,
  env: MentionEnv,
): Promise<void> {
  const db = getDb(env.DB)
  const [author] = await db
    .select({ name: users.name, email: users.email, title: userTitleSql })
    .from(users)
    .where(eq(users.id, authorUserId))
    .all()
  const [bill] = await db
    .select({
      billNumber: bills.billNumber,
      title: bills.title,
      isDraft: bills.isDraft,
      id: bills.id,
      state: bills.state,
      session: bills.session,
      sessionSlug: bills.sessionSlug,
      priority: bills.priority,
      tenantSummary: bills.tenantSummary,
    })
    .from(bills)
    .where(eq(bills.id, billId))
    .all()
  if (!author || !bill) return

  const [commentMeta] = await db
    .select({ createdAt: comments.createdAt })
    .from(comments)
    .where(eq(comments.id, commentId))
    .all()
  const commentCreatedAt = commentMeta?.createdAt ?? new Date().toISOString() // ts-write-ok: display-only fallback, not a DB column

  // Split under D1's parameter limit: an @everyone can reach more than 100 people.
  const recipients = (await Promise.all(chunk(targets.map(t => t.userId), D1_MAX_PARAMS).map(ids => db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(inArray(users.id, ids))
    .all()))).flat()

  const instanceName = (await resolveAssocName(env, db)) ?? ''

  console.log(`[mentions] sending email to ${recipients.length} recipient(s) for bill ${bill.billNumber}`)

  const messages = recipients.map((recipient): NotificationMessage => {
    const target = targets.find(t => t.userId === recipient.id)
    const via = target?.via ?? 'user'
    // `html` is sendMentionEmails's raw-tiptap comment param — passed through to
    // renderMentionEmail, which styles it via tiptapToEmailHtml.
    const rendered = renderMentionEmail({
      appUrl: env.APP_URL,
      author: { name: displayName(author), title: author.title },
      bill: {
        id: bill.id, billNumber: bill.billNumber, title: bill.title, isDraft: bill.isDraft,
        state: bill.state, session: bill.session, sessionSlug: bill.sessionSlug, priority: bill.priority,
        tenantSummary: bill.tenantSummary,
      },
      comment: { id: commentId, createdAt: commentCreatedAt, html },
      via, roleName: target?.roleName ?? null, instanceName,
    })
    const subject = via === 'everyone'
      ? `[${bill.billNumber}] New comment for everyone`
      : via === 'admins'
        ? `[${bill.billNumber}] The admins were mentioned in a comment`
        : `[${bill.billNumber}] You were mentioned in a comment`
    return { purpose: 'notification', to: [recipient.email], subject, html: rendered }
  })

  const { sent, failed } = await senderFor(env, db).sendBatch(messages)
  console.log(`[mentions ${bill.billNumber}] sent ${sent}, failed ${failed}`)
}
