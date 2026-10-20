// The notifications inbox: one stored row per event a member is notified about.
//
// Each kind has a writer and a renderer. The writer stores rows when the event
// happens (mentions: lib/mentions.ts, replies: lib/replies.ts, reactions:
// lib/reactions.ts, all through writeNotifications below). The renderer turns a stored row into the API shape
// GET /notifications returns, discriminated on `kind`. Adding a kind means adding it to the schema's `kind`
// enum, a writer, and a renderer here, and a renderer in the web panel.
//
// Notifications for deleted comments are hidden here, at read time, rather than
// deleted when the comment is.
import { and, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import type { getDb } from '../db/client'
import { notifications, comments, users, bills, roles, type MentionNotificationData, type ReplyNotificationData, type ReactionNotificationData, type NotificationKind } from '../db/schema'
import { filedSlug } from './sessionSlug'
import { stripHtml } from './stripHtml'
import { chunk, D1_MAX_PARAMS } from './chunk'
import { nowDb } from './dbTime'
import { activeUser } from './accountDeletion'
import { userDisplayNameSql } from './displayName'
import { userTitleSql } from './userTitle'

type Db = ReturnType<typeof getDb>

export type NewNotification = {
  recipientId: string
  kind: NotificationKind
  billId: string
  commentId: string
  actorId: string
  /** Kind-specific data, stored as JSON. */
  data: MentionNotificationData | ReplyNotificationData | ReactionNotificationData
}

/**
 * Stores notifications. A row its kind already has (a mention is unique per
 * comment and recipient, a reaction per comment, reactor, and emoji) is skipped rather than duplicated, which is what keeps
 * two concurrent edits of one comment from notifying a person twice.
 *
 * Returns the ids of the recipients actually written, so a caller emails only them.
 */
export async function writeNotifications(db: Db, rows: NewNotification[]): Promise<Set<string>> {
  const written = new Set<string>()
  if (rows.length === 0) return written
  const values = rows.map(r => ({
    id: crypto.randomUUID(),
    recipientId: r.recipientId,
    kind: r.kind,
    billId: r.billId,
    commentId: r.commentId,
    actorId: r.actorId,
    data: JSON.stringify(r.data),
  }))
  // Each row binds one parameter per column, so an @everyone on a larger
  // instance is split to stay under D1's limit.
  const rowsPerStatement = Math.floor(D1_MAX_PARAMS / Object.keys(values[0]).length)
  const statements = chunk(values, rowsPerStatement).map(slice => db.insert(notifications)
    .values(slice)
    .onConflictDoNothing()
    .returning({ recipientId: notifications.recipientId }))
  const results = await db.batch(statements as unknown as Parameters<typeof db.batch>[0]) as unknown as Array<Array<{ recipientId: string }>>
  for (const result of results) for (const r of result) written.add(r.recipientId)
  return written
}

/**
 * Reads a mention row's data, or null if it is not a mention's data. Callers
 * skip a bad row rather than failing the whole panel over it.
 */
export function mentionData(data: string): MentionNotificationData | null {
  try {
    const d = JSON.parse(data) as Partial<MentionNotificationData> | null
    if (d && (d.sourceType === 'user' || d.sourceType === 'role' || d.sourceType === 'admins' || d.sourceType === 'everyone') && typeof d.sourceId === 'string') {
      return { sourceType: d.sourceType, sourceId: d.sourceId }
    }
  } catch {}
  console.error('[notifications] skipping a mention notification with unreadable data')
  return null
}

/** Shared by every kind: where the notification points, and whether it's been read. */
type NotificationBase = {
  id: string
  commentId: string
  billId: string
  billNumber: string
  billTitle: string
  billState: string | null
  /** Drives the dashed BillBadge variant on the row's bill footer. A draft is
   *  fully commentable, so a notification on one is an ordinary case. */
  billIsDraft: boolean
  sessionSlug: string | null
  createdAt: string
  isUnread: boolean
}

export type MentionNotificationView = NotificationBase & {
  kind: 'mention'
  authorId: string
  authorName: string | null
  authorTitle: string | null
  /** The old name for `authorTitle`. Remove in the release after this one. */
  authorSubtitle: string | null
  commentPreview: string
  commentHtml: string
  sourceType: MentionNotificationData['sourceType']
  sourceLabel: string | null
}

/** Someone else commented on a bill the recipient has commented on. */
export type ReplyNotificationView = NotificationBase & {
  kind: 'reply'
  authorId: string
  authorName: string | null
  authorTitle: string | null
  /** The old name for `authorTitle`. Remove in the release after this one. */
  authorSubtitle: string | null
  commentPreview: string
  commentHtml: string
}

/**
 * Someone reacted to the recipient's comment. Stored one row per reactor and
 * emoji, rendered as one row per comment: `id` is fixed per comment, so the row
 * keeps it as reactions arrive, `isUnread` is true if any stored row is, and
 * `createdAt` is the newest's.
 */
export type ReactionNotificationView = NotificationBase & {
  kind: 'reaction'
  commentPreview: string
  commentHtml: string
  /** The newest reactors (up to two), each once however many emoji they used. */
  reactors: Array<{ id: string; name: string | null }>
  reactorCount: number
  /** The comment's distinct emoji, newest first. */
  emoji: string[]
}

export type NotificationView = MentionNotificationView | ReplyNotificationView | ReactionNotificationView

/** What a stored notification row joined to its comment and bill carries. */
type BaseRow = {
  id: string
  commentId: string
  billId: string
  billNumber: string
  billTitle: string
  billAbstract: string | null
  billState: string | null
  billSession: string | null
  billSessionSlug: string | null
  billIsDraft: boolean
  createdAt: string
  readAt: string | null
}

function notificationBase(r: BaseRow): NotificationBase {
  return {
    id: r.id,
    commentId: r.commentId,
    billId: r.billId,
    billNumber: r.billNumber,
    billTitle: r.billAbstract ?? r.billTitle,
    billState: r.billState,
    billIsDraft: r.billIsDraft,
    sessionSlug: filedSlug({ session: r.billSession, sessionSlug: r.billSessionSlug }),
    createdAt: r.createdAt,
    isUnread: r.readAt === null,
  }
}

const LIST_LIMIT = 50
// The ReactionRow headline names at most two reactors and counts the rest.
const REACTORS_NAMED = 2

/**
 * A member's newest notifications, rendered for GET /notifications. The unread
 * count covers the rows returned.
 */
export async function listNotifications(db: Db, recipientId: string): Promise<{ unreadCount: number; notifications: NotificationView[] }> {
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      commentId: comments.id,
      data: notifications.data,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      commentContent: comments.content,
      actorId: users.id,
      actorName: userDisplayNameSql,
      actorTitle: userTitleSql,
      billId: bills.id,
      billNumber: bills.billNumber,
      billTitle: bills.title,
      billAbstract: bills.abstract,
      billState: bills.state,
      billSession: bills.session,
      billSessionSlug: bills.sessionSlug,
      billIsDraft: bills.isDraft,
    })
    .from(notifications)
    // Every kind so far concerns a comment. A kind without one (comment_id is
    // nullable for it) will need a left join here.
    .innerJoin(comments, eq(notifications.commentId, comments.id))
    .innerJoin(users, eq(notifications.actorId, users.id))
    .innerJoin(bills, eq(notifications.billId, bills.id))
    .where(and(eq(notifications.recipientId, recipientId), isNull(comments.deletedAt), activeUser, ne(notifications.kind, 'reaction')))
    // rowid breaks ties inside one second, so "newest" is well defined.
    .orderBy(desc(notifications.createdAt), sql`${notifications}.rowid desc`)
    .limit(LIST_LIMIT)
    .all()
  const reactions = await listReactionGroups(db, recipientId)

  // Kind-specific data, parsed once. A row whose data can't be read is dropped.
  type Row = (typeof rows)[number]
  type Parsed = (Row & { kind: 'mention'; mention: MentionNotificationData }) | (Row & { kind: 'reply' })
  const parsed = rows.flatMap((r): Parsed[] => {
    switch (r.kind) {
      case 'mention': {
        const data = mentionData(r.data)
        return data ? [{ ...r, kind: r.kind, mention: data }] : []
      }
      case 'reply':
        return [{ ...r, kind: r.kind }]
      default:
        return []
    }
  })

  // Role names for role mentions, looked up once for the whole page.
  const roleIds = [...new Set(parsed.flatMap(r => r.kind === 'mention' && r.mention.sourceType === 'role' ? [r.mention.sourceId] : []))]
  const roleNames = new Map<string, string>()
  if (roleIds.length > 0) {
    const roleRows = await db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)).all()
    for (const r of roleRows) roleNames.set(r.id, r.name)
  }

  const rendered = parsed.map((r): NotificationView => {
    const base = notificationBase(r)
    switch (r.kind) {
      case 'mention':
        return {
          ...base,
          kind: 'mention',
          authorId: r.actorId,
          authorName: r.actorName,
          authorTitle: r.actorTitle,
          // The old name for `authorTitle`. Remove in the release after this one.
          authorSubtitle: r.actorTitle,
          commentPreview: stripHtml(r.commentContent).slice(0, 150),
          commentHtml: r.commentContent,
          sourceType: r.mention.sourceType,
          sourceLabel: r.mention.sourceType === 'role' ? (roleNames.get(r.mention.sourceId) ?? null) : null,
        }
      case 'reply':
        return {
          ...base,
          kind: 'reply',
          authorId: r.actorId,
          authorName: r.actorName,
          authorTitle: r.actorTitle,
          // The old name for `authorTitle`. Remove in the release after this one.
          authorSubtitle: r.actorTitle,
          commentPreview: stripHtml(r.commentContent).slice(0, 150),
          commentHtml: r.commentContent,
        }
    }
  })

  const all = [...rendered, ...reactions]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, LIST_LIMIT)

  return {
    unreadCount: all.filter(n => n.isUnread).length,
    notifications: all,
  }
}

/**
 * The member's newest reacted comments, one view each, grouped in SQL so a busy
 * comment's rows (one per reactor and emoji) are never read one by one.
 */
async function listReactionGroups(db: Db, recipientId: string): Promise<ReactionNotificationView[]> {
  const visible = and(eq(notifications.recipientId, recipientId), eq(notifications.kind, 'reaction'), isNull(comments.deletedAt), activeUser)
  const groups = await db
    .select({
      commentId: comments.id,
      commentContent: comments.content,
      billId: bills.id,
      billNumber: bills.billNumber,
      billTitle: bills.title,
      billAbstract: bills.abstract,
      billState: bills.state,
      billSession: bills.session,
      billSessionSlug: bills.sessionSlug,
      billIsDraft: bills.isDraft,
      createdAt: sql<string>`max(${notifications.createdAt})`,
      // Null while any of the comment's reactions is unread.
      readAt: sql<string | null>`case when sum(${notifications.readAt} is null) > 0 then null else max(${notifications.readAt}) end`,
      reactorCount: sql<number>`count(distinct ${notifications.actorId})`,
    })
    .from(notifications)
    .innerJoin(comments, eq(notifications.commentId, comments.id))
    .innerJoin(users, eq(notifications.actorId, users.id))
    .innerJoin(bills, eq(notifications.billId, bills.id))
    .where(visible)
    .groupBy(notifications.commentId)
    .orderBy(sql`max(${notifications.createdAt}) desc`, sql`max(${notifications}.rowid) desc`)
    .limit(LIST_LIMIT)
    .all()
  if (groups.length === 0) return []

  // The newest few reactors of each listed comment, each once.
  const perReactor = db
    .select({
      commentId: sql<string>`${notifications.commentId}`.as('comment_id'),
      id: sql<string>`${notifications.actorId}`.as('actor_id'),
      name: userDisplayNameSql.as('actor_name'),
      rank: sql<number>`row_number() over (partition by ${notifications.commentId} order by max(${notifications.createdAt}) desc, max(${notifications}.rowid) desc)`.as('rank'),
    })
    .from(notifications)
    .innerJoin(comments, eq(notifications.commentId, comments.id))
    .innerJoin(users, eq(notifications.actorId, users.id))
    .where(and(visible, inArray(notifications.commentId, groups.map(g => g.commentId))))
    .groupBy(notifications.commentId, notifications.actorId)
    .as('per_reactor')
  const reactorRows = await db.select().from(perReactor).where(lte(perReactor.rank, REACTORS_NAMED)).orderBy(sql`${perReactor.rank}`).all()
  const reactors = new Map<string, Array<{ id: string; name: string | null }>>()
  for (const r of reactorRows) {
    const list = reactors.get(r.commentId) ?? []
    list.push({ id: r.id, name: r.name })
    reactors.set(r.commentId, list)
  }

  // Each listed comment's distinct emoji, newest first.
  const emojiRows = await db
    .select({
      commentId: sql<string>`${notifications.commentId}`,
      emoji: sql<string>`json_extract(${notifications.data}, '$.emoji')`,
    })
    .from(notifications)
    .innerJoin(comments, eq(notifications.commentId, comments.id))
    .innerJoin(users, eq(notifications.actorId, users.id))
    .where(and(visible, inArray(notifications.commentId, groups.map(g => g.commentId))))
    .groupBy(notifications.commentId, sql`json_extract(${notifications.data}, '$.emoji')`)
    .orderBy(sql`max(${notifications.createdAt}) desc`, sql`max(${notifications}.rowid) desc`)
    .all()
  const emoji = new Map<string, string[]>()
  for (const r of emojiRows) {
    if (typeof r.emoji !== 'string') continue
    emoji.set(r.commentId, [...(emoji.get(r.commentId) ?? []), r.emoji])
  }

  return groups.map(g => ({
    ...notificationBase({ ...g, id: `reaction:${g.commentId}` }),
    kind: 'reaction',
    commentPreview: stripHtml(g.commentContent).slice(0, 150),
    commentHtml: g.commentContent,
    reactors: reactors.get(g.commentId) ?? [],
    reactorCount: g.reactorCount,
    emoji: emoji.get(g.commentId) ?? [],
  }))
}

/** Marks every unread notification of the member's read (the panel opened). */
export async function markAllRead(db: Db, recipientId: string): Promise<void> {
  await db.update(notifications)
    .set({ readAt: nowDb() })
    .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
}

/** Marks the member's notifications about one comment read. */
export async function markCommentRead(db: Db, recipientId: string, commentId: string): Promise<void> {
  await db.update(notifications)
    .set({ readAt: nowDb() })
    .where(and(eq(notifications.recipientId, recipientId), eq(notifications.commentId, commentId), isNull(notifications.readAt)))
}

/** Marks the member's notifications about one bill read (its page opened). */
export async function markBillRead(db: Db, recipientId: string, billId: string): Promise<void> {
  await db.update(notifications)
    .set({ readAt: nowDb() })
    .where(and(eq(notifications.recipientId, recipientId), eq(notifications.billId, billId), isNull(notifications.readAt)))
}
