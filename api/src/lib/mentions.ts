import { getDb } from '../db/client'
import { commentMentions, userRoles, users, bills, roles, sessions, associationConfig, comments } from '../db/schema'
import { eq, inArray, exists, and } from 'drizzle-orm'
import { billUrl } from '../../../shared/sessionSlug'
import { PRODUCT_NAME } from '../../../shared/brand'
import { sendBatch, resolveAssocName } from './email'
import { color, fontSize, fontWeight, radius } from '../../../shared/tokens'
import { buildBillCardModel } from '../../../shared/billCardModel'
import { MENTION_STYLE } from '../../../shared/mentionStyle'
import { renderBillCardOpen, BILL_CARD_CLOSE, renderCommentRow, formatEmailDateTime } from './emailBillCard'
import { renderEmailShell, emailButton, emailFooterLink } from './emailShell'
import { sanitizeCommentHtml } from './sanitizeHtml'

/** @mention emails are on unless an admin explicitly disabled them. */
export async function mentionEmailsEnabled(db: ReturnType<typeof getDb>): Promise<boolean> {
  const row = await db.select().from(associationConfig).where(eq(associationConfig.key, 'mention_emails_enabled')).get()
  if (!row) return true
  try { return JSON.parse(row.value) !== false } catch { return true }
}

type Mention = {
  type: 'user' | 'role' | 'everyone'
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
    const idMatch = span.match(/data-id="(user|role|everyone):([^"]+)"/)
    const labelMatch = span.match(/data-label="([^"]+)"/)
    if (idMatch && labelMatch) {
      const key = `${idMatch[1]}:${idMatch[2]}`
      if (!seen.has(key)) {
        seen.add(key)
        mentions.push({
          type: idMatch[1] as 'user' | 'role' | 'everyone',
          id: idMatch[2],
          label: labelMatch[1],
        })
      }
    }
  }

  // Handle attributes in different order (data-id before data-type)
  const altPattern = /<span[^>]*data-id="(user|role|everyone):([^"]+)"[^>]*data-type="mention"[^>]*>/g
  while ((match = altPattern.exec(html)) !== null) {
    const key = `${match[1]}:${match[2]}`
    if (seen.has(key)) continue
    const span = match[0]
    const labelMatch = span.match(/data-label="([^"]+)"/)
    if (labelMatch) {
      seen.add(key)
      mentions.push({
        type: match[1] as 'user' | 'role' | 'everyone',
        id: match[2],
        label: labelMatch[1],
      })
    }
  }

  return mentions
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
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
        const isGroup = match.includes('data-id="role:') || match.includes('data-id="everyone:')
        const pill = isGroup ? MENTION_STYLE.role : MENTION_STYLE.user
        const rad = isGroup ? '99px' : '4px'
        const pad = isGroup ? '2px 8px' : '1px 6px'
        return `<span style="background:${pill.bg};color:${pill.text};padding:${pad};border-radius:${rad};font-weight:500;">${label}</span>`
      },
    )
}

export interface MentionEmailInput {
  appUrl: string
  author: { name: string; subtitle: string | null }
  bill: {
    id: string; billNumber: string; title: string
    state: string | null; session: string
    priority: 'high' | 'medium' | 'low' | null
    tenantSummary: string | null
  }
  comment: { id: string; createdAt: string; html: string }
  via: 'user' | 'role' | 'everyone'
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
    billPriority: bill.priority, billMatchType: null, date: '', events: [],
  })
  const billHref = `${appUrl}${billUrl({ id: bill.id, state: bill.state, session: bill.session, billNumber: bill.billNumber })}`
  const commentUrl = `${billHref}#comment-${comment.id}`
  const subtitle = author.subtitle ? truncate(author.subtitle, 60) : null
  const commentRow = renderCommentRow({
    appUrl, name: author.name, subtitle,
    dateText: formatEmailDateTime(comment.createdAt),
    bodyHtml: tiptapToEmailHtml(comment.html),
  })
  const card = `${renderBillCardOpen({ model, billHref, appUrl })}
    ${commentRow}${BILL_CARD_CLOSE}`

  const authorName = escHtml(author.name)
  const strong = (s: string) => `<strong style="font-weight:${fontWeight.semibold};">${s}</strong>`
  const intro = via === 'everyone'
    ? `${strong(authorName)} notified everyone in a comment`
    : (via === 'role' && roleName)
      ? `${strong(authorName)} mentioned ${strong(`@${escHtml(roleName)}`)} in a comment`
      : `${strong(authorName)} mentioned you in a comment`

  const roleNote = (via === 'role' && roleName)
    ? `<p style="margin:0 0 20px;font-size:${fontSize.sm}px;color:${color.textSecondary};">You're receiving this because your account has the <span style="font-size:${fontSize.xs}px;font-weight:${fontWeight.medium};color:${MENTION_STYLE.role.text};background:${MENTION_STYLE.role.bg};border-radius:${radius.pill}px;padding:3px 9px;display:inline-block;white-space:nowrap;">${escHtml(roleName)}</span> role.</p>`
    : ''
  const everyoneNote = via === 'everyone'
    ? `<p style="margin:0 0 20px;font-size:${fontSize.sm}px;color:${color.textSecondary};">You're receiving this because an admin notified everyone.</p>`
    : ''

  return renderEmailShell({
    instanceName,
    signalHtml: intro,
    dateLabel: formatEmailDateTime(comment.createdAt),
    bodyHtml: `${card}${roleNote}${everyoneNote}`,
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
  via: 'user' | 'role' | 'everyone'
  roleName?: string
}

export async function extractAndNotifyMentions(
  commentId: string,
  html: string,
  authorUserId: string,
  authorRole: 'admin' | 'member' | 'owner',
  billId: string,
  env: MentionEnv,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<string[]> {
  const mentions = extractMentions(html)
  if (mentions.length === 0) return []

  const db = getDb(env.DB)
  const targets = new Map<string, NotificationTarget>()
  const mentionRows: Array<{
    id: string
    commentId: string
    userId: string
    sourceType: 'user' | 'role' | 'everyone'
    sourceId: string
  }> = []

  for (const m of mentions) {
    if (m.type === 'user') {
      if (m.id !== authorUserId && !targets.has(m.id)) {
        targets.set(m.id, { userId: m.id, via: 'user' })
        mentionRows.push({
          id: crypto.randomUUID(),
          commentId,
          userId: m.id,
          sourceType: 'user',
          sourceId: m.id,
        })
      }
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
        targets.set(rm.userId, { userId: rm.userId, via: 'role', roleName: roleNameMap.get(rm.roleId) })
        mentionRows.push({
          id: crypto.randomUUID(),
          commentId,
          userId: rm.userId,
          sourceType: 'role',
          sourceId: rm.roleId,
        })
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
        targets.set(u.id, { userId: u.id, via: 'everyone' })
        mentionRows.push({
          id: crypto.randomUUID(),
          commentId,
          userId: u.id,
          sourceType: 'everyone',
          sourceId: 'all',
        })
      }
    }
  }

  if (mentionRows.length > 0) {
    await db.insert(commentMentions).values(mentionRows)
  }

  if (targets.size > 0) {
    const targetList = [...targets.values()]
    if (await mentionEmailsEnabled(db)) {
      const emailTask = sendMentionEmails(targetList, authorUserId, billId, commentId, html, env)
      if (waitUntil) {
        waitUntil(emailTask)
      } else {
        emailTask.catch(() => {})
      }
    }
    return targetList.map(t => t.userId)
  }

  return []
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
    .select({ name: users.name, subtitle: users.subtitle })
    .from(users)
    .where(eq(users.id, authorUserId))
    .all()
  const [bill] = await db
    .select({
      billNumber: bills.billNumber,
      title: bills.title,
      id: bills.id,
      state: bills.state,
      session: bills.session,
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

  const recipients = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(inArray(users.id, targets.map(t => t.userId)))
    .all()

  const instanceName = (await resolveAssocName(env, db)) ?? ''

  console.log(`[mentions] sending email to ${recipients.length} recipient(s) for bill ${bill.billNumber}`)

  const emailObjects = recipients.map(recipient => {
    const target = targets.find(t => t.userId === recipient.id)
    const via = target?.via ?? 'user'
    // `html` is sendMentionEmails's raw-tiptap comment param — passed through to
    // renderMentionEmail, which styles it via tiptapToEmailHtml.
    const rendered = renderMentionEmail({
      appUrl: env.APP_URL,
      author: { name: author.name, subtitle: author.subtitle },
      bill: {
        id: bill.id, billNumber: bill.billNumber, title: bill.title,
        state: bill.state, session: bill.session, priority: bill.priority,
        tenantSummary: bill.tenantSummary,
      },
      comment: { id: commentId, createdAt: commentCreatedAt, html },
      via, roleName: target?.roleName ?? null, instanceName,
    })
    const subject = via === 'everyone'
      ? `[${bill.billNumber}] New comment for everyone`
      : `[${bill.billNumber}] You were mentioned in a comment`
    return { to: [recipient.email], subject, html: rendered }
  })

  await sendBatch(env, emailObjects, `mentions ${bill.billNumber}`, db)
}
