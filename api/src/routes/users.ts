import { Hono } from 'hono'
import { eq, ne, and, inArray, isNull, exists } from 'drizzle-orm'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { users, bills, memberVotes, comments, notes, officialPositions, roles, userRoles, sessions, magicLinks, feedEvents, commentReactions } from '../db/schema'
import type { AppEnv } from '../types'
import { stripHtml } from '../lib/mentions'
import { dbTsToEpoch } from '../../../shared/time'

export const usersRouter = new Hono<AppEnv>()

usersRouter.use('*', requireAuth)

// GET /users — list all members (basic info, available to all authenticated users)
usersRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, subtitle: users.subtitle, role: users.role })
    .from(users)
    .orderBy(users.name)
    .all()

  const userIds = rows.map(u => u.id)
  const roleRows = userIds.length > 0
    ? await db
        .select({ userId: userRoles.userId, roleId: roles.id, roleName: roles.name })
        .from(userRoles)
        .innerJoin(roles, and(eq(userRoles.roleId, roles.id), isNull(roles.deletedAt)))
        .where(inArray(userRoles.userId, userIds))
        .all()
    : []
  const rolesByUser = new Map<string, { id: string; name: string }[]>()
  for (const row of roleRows) {
    if (!rolesByUser.has(row.userId)) rolesByUser.set(row.userId, [])
    rolesByUser.get(row.userId)!.push({ id: row.roleId, name: row.roleName })
  }

  return c.json(rows.map(u => ({ ...u, roles: rolesByUser.get(u.id) ?? [] })))
})

// PATCH /users/me — update subtitle, name, and/or emailDigestEnabled
usersRouter.patch('/me', async (c) => {
  const db = getDb(c.env.DB)
  const currentUser = c.get('user')
  const body = await c.req.json<{ subtitle?: string; name?: string; emailDigestEnabled?: boolean; emailWeekAheadEnabled?: boolean }>().catch(() => ({} as { subtitle?: string; name?: string; emailDigestEnabled?: boolean; emailWeekAheadEnabled?: boolean }))
  const subtitle = body.subtitle?.trim() || null
  const trimmedName = body.name?.trim() || undefined
  if (subtitle && subtitle.length > 200) {
    return c.json({ error: 'Subtitle too long (max 200 characters)' }, 400)
  }
  if (trimmedName && trimmedName.length > 100) {
    return c.json({ error: 'Name too long (max 100 characters)' }, 400)
  }
  const updates: { subtitle: string | null; name?: string; emailDigestEnabled?: number; emailWeekAheadEnabled?: number } = { subtitle }
  if (trimmedName) updates.name = trimmedName
  if (typeof body.emailDigestEnabled === 'boolean') {
    updates.emailDigestEnabled = body.emailDigestEnabled ? 1 : 0
  }
  if (typeof body.emailWeekAheadEnabled === 'boolean') {
    updates.emailWeekAheadEnabled = body.emailWeekAheadEnabled ? 1 : 0
  }
  await db.update(users).set(updates).where(eq(users.id, currentUser.id))
  return c.json({
    subtitle,
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(typeof body.emailDigestEnabled === 'boolean' ? { emailDigestEnabled: body.emailDigestEnabled } : {}),
    ...(typeof body.emailWeekAheadEnabled === 'boolean' ? { emailWeekAheadEnabled: body.emailWeekAheadEnabled } : {}),
  })
})

// DELETE /users/me — delete own account
usersRouter.delete('/me', async (c) => {
  const db = getDb(c.env.DB)
  const currentUser = c.get('user')

  const userCommentIds = await db
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.userId, currentUser.id))
    .all()
  if (userCommentIds.length > 0) {
    await db.delete(commentReactions).where(
      inArray(commentReactions.commentId, userCommentIds.map((c) => c.id)),
    )
  }
  await db.delete(commentReactions).where(eq(commentReactions.userId, currentUser.id))

  await db.batch([
    db.delete(sessions).where(eq(sessions.userId, currentUser.id)),
    db.delete(magicLinks).where(eq(magicLinks.userId, currentUser.id)),
    db.delete(comments).where(eq(comments.userId, currentUser.id)),
    db.delete(memberVotes).where(eq(memberVotes.userId, currentUser.id)),
    db.delete(notes).where(eq(notes.userId, currentUser.id)),
    db.delete(feedEvents).where(eq(feedEvents.userId, currentUser.id)),
    db.delete(users).where(eq(users.id, currentUser.id)),
  ])

  return c.json({ ok: true })
})

// GET /users/me/bills — bills the user has voted on, commented on, or noted
usersRouter.get('/me/bills', async (c) => {
  const db = getDb(c.env.DB)
  const currentUser = c.get('user')

  const [myVoteRows, myCommentRows, myNoteRows] = await Promise.all([
    db.select({ billId: memberVotes.billId, position: memberVotes.position, updatedAt: memberVotes.updatedAt })
      .from(memberVotes).where(eq(memberVotes.userId, currentUser.id)).all(),
    db.select({ billId: comments.billId, content: comments.content, createdAt: comments.createdAt })
      .from(comments).where(eq(comments.userId, currentUser.id)).all(),
    db.select({ billId: notes.billId, updatedAt: notes.updatedAt, content: notes.content })
      .from(notes).where(and(eq(notes.userId, currentUser.id), ne(notes.content, ''))).all(),
  ])

  const billIds = [
    ...new Set([
      ...myVoteRows.map((r) => r.billId),
      ...myCommentRows.map((r) => r.billId),
      ...myNoteRows.map((r) => r.billId),
    ]),
  ]

  if (billIds.length === 0) return c.json([])

  const [billRows, positionRows] = await Promise.all([
    db.select().from(bills).where(inArray(bills.id, billIds)).all(),
    db.select().from(officialPositions).where(inArray(officialPositions.billId, billIds)).all(),
  ])

  const positionByBill = new Map(positionRows.map((p) => [p.billId, p.position]))
  const voteByBill = new Map(myVoteRows.map((v) => [v.billId, v]))
  const noteByBill = new Map(myNoteRows.map((n) => [n.billId, n]))

  // Build map of most-recent comment per bill
  const latestCommentByBill = new Map<string, (typeof myCommentRows)[0]>()
  for (const row of myCommentRows) {
    const existing = latestCommentByBill.get(row.billId)
    if (!existing || dbTsToEpoch(row.createdAt) > dbTsToEpoch(existing.createdAt)) {
      latestCommentByBill.set(row.billId, row)
    }
  }

  const billById = new Map(billRows.map((b) => [b.id, b]))

  const result = billIds
    .map((billId) => {
      const bill = billById.get(billId)
      if (!bill) return null
      const vote = voteByBill.get(billId)
      const note = noteByBill.get(billId)
      const timestamps = [
        vote?.updatedAt,
        note?.updatedAt,
        ...myCommentRows.filter((c) => c.billId === billId).map((c) => c.createdAt),
      ].filter(Boolean).map((d) => new Date(d!).getTime())
      const touched = timestamps.reduce((max, t) => Math.max(max, t), -Infinity)
      const latestComment = latestCommentByBill.get(billId)
      const commentRaw = latestComment ? stripHtml(latestComment.content) : null
      const commentPreview = commentRaw
        ? commentRaw.length > 320 ? commentRaw.slice(0, 320) + '…' : commentRaw
        : null
      const notePreview = note
        ? note.content.length > 320 ? note.content.slice(0, 320) + '…' : note.content
        : null
      return {
        id: bill.id,
        billNumber: bill.billNumber,
        title: bill.title,
        myVote: vote?.position ?? null,
        position: positionByBill.get(billId) ?? null,
        hasComment: latestCommentByBill.has(billId),
        hasNote: !!note,
        commentPreview,
        notePreview,
        lastTouched: isFinite(touched) ? new Date(touched).toISOString() : bill.updatedAt,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b!.lastTouched.localeCompare(a!.lastTouched))

  return c.json(result)
})

// -- Roles router --

export const rolesRouter = new Hono<AppEnv>()
rolesRouter.use('*', requireAuth)

rolesRouter.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const allRoles = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(isNull(roles.deletedAt))
    .orderBy(roles.name)
    .all()

  if (allRoles.length === 0) return c.json([])

  const roleIds = allRoles.map(r => r.id)
  const memberRows = await db
    .select({
      roleId: userRoles.roleId,
      userId: users.id,
      name: users.name,
      email: users.email,
      subtitle: users.subtitle,
    })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(inArray(userRoles.roleId, roleIds), exists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, users.id)))))
    .all()

  const membersByRole = new Map<string, Array<{ id: string; name: string; email?: string; subtitle: string | null }>>()
  for (const row of memberRows) {
    if (!membersByRole.has(row.roleId)) membersByRole.set(row.roleId, [])
    membersByRole.get(row.roleId)!.push({ id: row.userId, name: row.name, email: row.email, subtitle: row.subtitle })
  }

  return c.json(allRoles.map(r => ({
    ...r,
    members: membersByRole.get(r.id) ?? [],
  })))
})
