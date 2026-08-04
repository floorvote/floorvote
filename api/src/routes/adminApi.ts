import { Hono } from 'hono'
import { eq, desc, sql, and, or, isNull, isNotNull, inArray, ne, gt } from 'drizzle-orm'
import { requireAuth, requireAdmin, requireOwner, demoGuard } from '../middleware/auth'
import { getDb } from '../db/client'
import { users, sessions, magicLinks, associationConfig, bills, comments, commentReactions, memberVotes, notes, feedEvents, officialPositions, roles, userRoles, authEvents } from '../db/schema'
import { generateToken, hashToken } from '../lib/crypto'
import { sendMagicLink } from '../lib/email'
import { registerWithCentral } from '../cron/sync'
import { matchesKeywords } from '../lib/keywords'
import { centralFetch } from '../lib/centralFetch'
import { PRESETS } from '../lib/presets'
import { isSuperadminRequest } from '../lib/superadminRequest'
import { applyPresetConfig, ensureInstancePreset } from '../lib/instancePreset'
import { parseTaxonomyItems } from '../lib/taxonomy'
import { resolveOrgNoun } from '../../../shared/orgNoun'
import { nowDb } from '../lib/dbTime'
import { recordAuthEvent, authReqContext } from '../lib/authEvents'
import { getAccountDeletionEnabled, ACCOUNT_DELETION_KEY } from '../lib/accountDeletion'
import { countActiveOwners } from '../lib/owners'
import { exportApiRouter } from './exportApi'
import { customFieldsApiRouter } from './customFieldsApi'
import type { AppEnv } from '../types'

export const adminApiRouter = new Hono<AppEnv>()

adminApiRouter.use('*', requireAuth, requireAdmin)

adminApiRouter.route('/export', exportApiRouter)
adminApiRouter.route('/custom-fields', customFieldsApiRouter)

// GET /admin/members
adminApiRouter.get('/members', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      subtitle: users.subtitle,
      createdAt: users.createdAt,
      lastActive: users.lastActive,
      deactivatedAt: users.deactivatedAt,
      canVote: users.canVote,
      invitedBy: users.invitedBy,
      hasLoggedIn: sql<number>`CASE WHEN EXISTS (
        SELECT 1 FROM magic_links WHERE user_id = users.id AND used_at IS NOT NULL
      ) THEN 1 ELSE 0 END`,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
    .all()

  // Resolve invitedBy IDs to names/emails in one extra query
  const inviterIds = [...new Set(rows.map(u => u.invitedBy).filter(Boolean))] as string[]
  const inviters = inviterIds.length > 0
    ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, inviterIds)).all()
    : []
  const inviterMap = Object.fromEntries(inviters.map(i => [i.id, i]))

  // Fetch roles for all members in one query
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

  // Fetch vote counts per user
  const voteCountRows = userIds.length > 0
    ? await db
        .select({ userId: memberVotes.userId, count: sql<number>`COUNT(*)` })
        .from(memberVotes)
        .where(inArray(memberVotes.userId, userIds))
        .groupBy(memberVotes.userId)
        .all()
    : []
  const voteCountByUser = new Map(voteCountRows.map(r => [r.userId, r.count]))

  // Per-user login-trouble signal (last 14 days): >=2 *login* link requests AND the most
  // recent login request is more recent than the last successful sign-in (i.e. they've been
  // asking for links since they last got in, or never got in). This catches the "accepted
  // once, now locked out" case — not just never-logged-in users — while ignoring invite
  // links (a normal pending/resent invite shouldn't read as login trouble).
  // Predicate compares the bare column (space-format UTC) to a literal so the
  // (user_id, created_at) index stays sargable — no datetime() wrapper on the column.
  const troubleRows = await db
    .select({
      userId: authEvents.userId,
      loginRequests: sql<number>`SUM(CASE WHEN ${authEvents.event} = 'link_requested' AND ${authEvents.linkType} = 'login' THEN 1 ELSE 0 END)`,
      lastSuccess: sql<string | null>`MAX(CASE WHEN ${authEvents.event} = 'verify_success' THEN ${authEvents.createdAt} END)`,
      lastLoginRequest: sql<string | null>`MAX(CASE WHEN ${authEvents.event} = 'link_requested' AND ${authEvents.linkType} = 'login' THEN ${authEvents.createdAt} END)`,
    })
    .from(authEvents)
    .where(gt(authEvents.createdAt, sql`datetime('now', '-14 days')`))
    .groupBy(authEvents.userId)
    .all()
  const troubleByUser = new Map(troubleRows.map(r => [
    r.userId,
    (r.loginRequests ?? 0) >= 2 && (!r.lastSuccess || (r.lastLoginRequest ?? '') > r.lastSuccess),
  ]))

  return c.json(
    rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      subtitle: u.subtitle,
      createdAt: u.createdAt,
      lastActive: u.lastActive,
      deactivatedAt: u.deactivatedAt,
      hasLoggedIn: !!u.hasLoggedIn,
      canVote: !!u.canVote,
      voteCount: voteCountByUser.get(u.id) ?? 0,
      invitedBy: u.invitedBy ? (inviterMap[u.invitedBy] ?? null) : null,
      roles: rolesByUser.get(u.id) ?? [],
      loginTrouble: troubleByUser.get(u.id) ?? false,
    })),
  )
})

// Pacing for the invite-email blast: stagger sends so a large onboarding does
// not burst on a warming sender IP. Tunable; ~3s/email keeps a 500-batch under
// ~25 min. Capped so the tail never exceeds an hour.
const INVITE_SEND_STAGGER_SECONDS = 3
const INVITE_SEND_MAX_DELAY_SECONDS = 3600
const BULK_INVITE_MAX = 500
const USER_INSERT_CHUNK = 10      // 5 bound params/row (id,email,name,role,invitedBy — default cols aren't bound); 10*5=50, safely under D1's 100-param ceiling
const QUEUE_SEND_CHUNK = 100      // Cloudflare Queues sendBatch max per call

// POST /admin/members/bulk-invite
adminApiRouter.post('/members/bulk-invite', demoGuard, async (c) => {
  if (!c.env.BILL_QUEUE) return c.json({ error: 'Queue not configured' }, 503)

  const body = await c.req
    .json<{ invitees?: { name?: string; email?: string }[]; role?: string }>()
    .catch(() => ({} as { invitees?: { name?: string; email?: string }[]; role?: string }))

  const invitees = body.invitees
  if (!Array.isArray(invitees) || invitees.length === 0) {
    return c.json({ error: 'invitees must be a non-empty array' }, 400)
  }
  if (invitees.length > BULK_INVITE_MAX) {
    return c.json({ error: `Too many invitees (max ${BULK_INVITE_MAX})` }, 400)
  }

  const role: 'admin' | 'member' = body.role === 'admin' ? 'admin' : 'member'
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const db = getDb(c.env.DB)
  const inviterId = c.get('user').id

  // Normalize once.
  const normalized = invitees.map((inv) => ({
    email: (inv.email ?? '').toLowerCase().trim(),
    name: (inv.name ?? '').trim().slice(0, 100),
  }))

  // One lookup for all existing emails in the batch.
  const candidateEmails = [...new Set(normalized.filter(n => emailRegex.test(n.email)).map(n => n.email))]
  const existingRows = candidateEmails.length > 0
    ? await db.select({ email: users.email }).from(users).where(inArray(users.email, candidateEmails)).all()
    : []
  const existingSet = new Set(existingRows.map(r => r.email))

  type RowStatus = 'invited' | 'exists' | 'duplicate' | 'invalid'
  const results: { email: string; status: RowStatus; userId?: string }[] = []
  const toInsert: { id: string; email: string; name: string; role: 'admin' | 'member'; invitedBy: string }[] = []
  const created: { userId: string; email: string }[] = []
  const seen = new Set<string>()

  for (const n of normalized) {
    if (!n.email || !emailRegex.test(n.email)) { results.push({ email: n.email, status: 'invalid' }); continue }
    if (seen.has(n.email)) { results.push({ email: n.email, status: 'duplicate' }); continue }
    seen.add(n.email)
    if (existingSet.has(n.email)) { results.push({ email: n.email, status: 'exists' }); continue }
    const id = crypto.randomUUID()
    toInsert.push({ id, email: n.email, name: n.name, role, invitedBy: inviterId })
    created.push({ userId: id, email: n.email })
    results.push({ email: n.email, status: 'invited', userId: id })
  }

  // Chunked inserts (D1 bound-param ceiling).
  for (let i = 0; i < toInsert.length; i += USER_INSERT_CHUNK) {
    await db.insert(users).values(toInsert.slice(i, i + USER_INSERT_CHUNK))
  }

  // Enqueue paced invite-email jobs. The users are already persisted, so a
  // transient queue failure must not 500 the whole request — the created users
  // show as "Invite pending" and are recoverable via per-user "Resend invite".
  if (created.length > 0) {
    const messages = created.map((u, i) => ({
      body: { type: 'invite-email' as const, tenantId: c.env.TENANT_ID, userId: u.userId, email: u.email },
      delaySeconds: Math.min(i * INVITE_SEND_STAGGER_SECONDS, INVITE_SEND_MAX_DELAY_SECONDS),
    }))
    try {
      for (let i = 0; i < messages.length; i += QUEUE_SEND_CHUNK) {
        await c.env.BILL_QUEUE.sendBatch(messages.slice(i, i + QUEUE_SEND_CHUNK))
      }
    } catch (err) {
      console.error('[bulk-invite] enqueue failed; users created, invites recoverable via resend', err)
    }
  }

  const summary = {
    invited: results.filter(r => r.status === 'invited').length,
    exists: results.filter(r => r.status === 'exists').length,
    duplicate: results.filter(r => r.status === 'duplicate').length,
    invalid: results.filter(r => r.status === 'invalid').length,
  }
  return c.json({ summary, results })
})

// POST /admin/members/:id/resend-invite
adminApiRouter.post('/members/:id/resend-invite', async (c) => {
  const targetId = c.req.param('id')
  const db = getDb(c.env.DB)

  const target = await db
    .select({ id: users.id, email: users.email, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, targetId))
    .get()

  if (!target) return c.json({ error: 'User not found' }, 404)
  if (target.deactivatedAt) return c.json({ error: 'Cannot resend invite to a deactivated user' }, 400)

  const INVITE_DURATION_MS = 7 * 24 * 60 * 60 * 1000
  const rawToken = await generateToken()
  const tokenHash = await hashToken(rawToken)
  const expiresAt = new Date(Date.now() + INVITE_DURATION_MS).toISOString()

  await db.insert(magicLinks).values({
    id: crypto.randomUUID(),
    userId: target.id,
    tokenHash,
    expiresAt,
  })

  const url = `${c.env.APP_URL}/auth/verify?token=${encodeURIComponent(rawToken)}`
  await recordAuthEvent(db, { event: 'link_requested', email: target.email, userId: target.id, linkType: 'invite', ...authReqContext(c) })
  try {
    c.executionCtx.waitUntil(sendMagicLink(target.email, url, c.env, 'invite', db, target.id).catch(console.error))
  } catch {
    sendMagicLink(target.email, url, c.env, 'invite', db, target.id).catch(console.error)
  }

  return c.json({ ok: true })
})

// POST /admin/members/:id/resend-login
// Admin-initiated sign-in link for an existing member (e.g. one who can't
// receive/find their own). This is the authenticated sibling of the public
// POST /auth/magic-link: because the admin is already authenticated, it does NOT
// go through the Turnstile gate — the public endpoint's tokenless request would
// 403 ("Verification required.") wherever TURNSTILE_SECRET_KEY is set.
adminApiRouter.post('/members/:id/resend-login', async (c) => {
  const targetId = c.req.param('id')
  const db = getDb(c.env.DB)

  const target = await db
    .select({ id: users.id, email: users.email, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, targetId))
    .get()

  if (!target) return c.json({ error: 'User not found' }, 404)
  if (target.deactivatedAt) return c.json({ error: 'Cannot resend a login link to a deactivated user' }, 400)

  // Match the public login link's TTL (a wider window for slow mail gateways),
  // not the 7-day invite window — this is a login link, not an invitation.
  const LOGIN_LINK_DURATION_MS = 60 * 60 * 1000
  const rawToken = await generateToken()
  const tokenHash = await hashToken(rawToken)
  const expiresAt = new Date(Date.now() + LOGIN_LINK_DURATION_MS).toISOString()

  await db.insert(magicLinks).values({
    id: crypto.randomUUID(),
    userId: target.id,
    tokenHash,
    expiresAt,
  })

  const url = `${c.env.APP_URL}/auth/verify?token=${encodeURIComponent(rawToken)}`
  await recordAuthEvent(db, { event: 'link_requested', email: target.email, userId: target.id, linkType: 'login', ...authReqContext(c) })
  try {
    c.executionCtx.waitUntil(sendMagicLink(target.email, url, c.env, 'login', db, target.id).catch(console.error))
  } catch {
    sendMagicLink(target.email, url, c.env, 'login', db, target.id).catch(console.error)
  }

  return c.json({ ok: true })
})

// PATCH /admin/members/:id
adminApiRouter.patch('/members/:id', async (c) => {
  const targetId = c.req.param('id')
  const currentUser = c.get('user')
  const isSelf = targetId === currentUser.id

  const db = getDb(c.env.DB)
  const target = await db
    .select({ id: users.id, role: users.role, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, targetId))
    .get()
  if (!target) {
    return c.json({ error: 'User not found' }, 404)
  }

  const body = await c
    .req
    .json<{ role?: string; deactivated?: boolean; canVote?: boolean }>()
    .catch(() => ({} as { role?: string; deactivated?: boolean; canVote?: boolean }))

  if (body.role !== undefined && c.env.DEMO_MODE === 'true' && !(await isSuperadminRequest(c))) {
    return c.json({ error: 'Configuration is locked in demo mode' }, 403)
  }

  const updates: Partial<typeof users.$inferInsert> = {}

  if (body.role === 'admin' || body.role === 'member' || body.role === 'owner') {
    if (body.role === 'owner' || target.role === 'owner') {
      if (currentUser.role !== 'owner') {
        return c.json({ error: 'Only owners can change owner status' }, 403)
      }
    }
    if (target.role === 'owner' && body.role !== 'owner' && target.deactivatedAt == null) {
      if ((await countActiveOwners(db)) <= 1) {
        return c.json({ error: 'Cannot demote the last owner' }, 400)
      }
    }
    updates.role = body.role
  }
  // Changing an owner's active status is owner-only, and the last active owner
  // cannot be deactivated (mirrors the demote guard above; the client already
  // hides these actions via canManageThisMember + last-owner checks).
  if (body.deactivated !== undefined && target.role === 'owner') {
    if (currentUser.role !== 'owner') {
      return c.json({ error: 'Only owners can deactivate or reactivate an owner' }, 403)
    }
    if (body.deactivated === true && target.deactivatedAt == null && (await countActiveOwners(db)) <= 1) {
      return c.json({ error: 'Cannot deactivate the last owner' }, 400)
    }
  }
  if (body.deactivated === true) {
    updates.deactivatedAt = nowDb()
  } else if (body.deactivated === false) {
    updates.deactivatedAt = null
  }
  if (body.canVote === true) {
    updates.canVote = 1
  } else if (body.canVote === false) {
    updates.canVote = 0
  }

  if (Object.keys(updates).length > 0) {
    await db.update(users).set(updates).where(eq(users.id, targetId))
    // Invalidate sessions when role or deactivation changes so it takes effect immediately.
    // Skip for canVote-only updates — no need to boot the user for that.
    if (updates.role !== undefined || updates.deactivatedAt !== undefined) {
      await db.delete(sessions).where(eq(sessions.userId, targetId))
    }
  }

  return c.json({ ok: true })
})

// DELETE /admin/members/:id
adminApiRouter.delete('/members/:id', demoGuard, async (c) => {
  const targetId = c.req.param('id')
  const currentUser = c.get('user')

  if (targetId === currentUser.id) {
    return c.json({ error: 'Cannot delete your own account' }, 400)
  }

  const db = getDb(c.env.DB)
  if (!(await getAccountDeletionEnabled(db))) return c.json({ error: 'Account deletion is disabled' }, 403)

  const target = await db
    .select({ id: users.id, role: users.role, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, targetId))
    .get()
  if (!target) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Deleting an owner is owner-only, and the last active owner cannot be deleted
  // (the client already hides this via canManageThisMember + last-owner checks).
  if (target.role === 'owner') {
    if (currentUser.role !== 'owner') {
      return c.json({ error: 'Only owners can delete an owner' }, 403)
    }
    if (target.deactivatedAt == null && (await countActiveOwners(db)) <= 1) {
      return c.json({ error: 'Cannot delete the last owner' }, 400)
    }
  }

  // Delete comment reactions on the user's comments first (no direct userId column)
  const userCommentIds = await db
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.userId, targetId))
    .all()
  if (userCommentIds.length > 0) {
    await db.delete(commentReactions).where(
      inArray(commentReactions.commentId, userCommentIds.map((c) => c.id)),
    )
  }

  // Also delete reactions the user themselves placed on others' comments
  await db.delete(commentReactions).where(eq(commentReactions.userId, targetId))

  // Delete all user-owned rows atomically
  await db.batch([
    db.delete(sessions).where(eq(sessions.userId, targetId)),
    db.delete(magicLinks).where(eq(magicLinks.userId, targetId)),
    db.delete(comments).where(eq(comments.userId, targetId)),
    db.delete(memberVotes).where(eq(memberVotes.userId, targetId)),
    db.delete(notes).where(eq(notes.userId, targetId)),
    db.delete(feedEvents).where(eq(feedEvents.userId, targetId)),
    db.delete(users).where(eq(users.id, targetId)),
  ])

  return c.json({ ok: true })
})

// GET /admin/roles
adminApiRouter.get('/roles', async (c) => {
  const db = getDb(c.env.DB)
  const allRoles = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(isNull(roles.deletedAt))
    .orderBy(roles.name)
    .all()
  return c.json(allRoles)
})

// POST /admin/roles
adminApiRouter.post('/roles', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)
  if (name.includes('@')) return c.json({ error: 'Role names cannot contain @' }, 400)


  const db = getDb(c.env.DB)

  // Case-insensitive lookup — finds active or soft-deleted rows
  const existing = await db
    .select({ id: roles.id, name: roles.name, deletedAt: roles.deletedAt })
    .from(roles)
    .where(sql`lower(${roles.name}) = lower(${name})`)
    .get()

  if (existing) {
    if (existing.deletedAt === null) {
      return c.json({ error: 'A role with this name already exists' }, 409)
    }
    // Restore: clear deleted_at/deleted_by, keep original name casing and UUID
    await db.update(roles)
      .set({ deletedAt: null, deletedBy: null })
      .where(eq(roles.id, existing.id))
    return c.json({ id: existing.id, name: existing.name }, 200)
  }

  const id = crypto.randomUUID()
  await db.insert(roles).values({ id, name })
  return c.json({ id, name }, 201)
})

// PATCH /admin/roles/:id
adminApiRouter.patch('/roles/:id', async (c) => {
  const roleId = c.req.param('id')
  const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)
  if (name.includes('@')) return c.json({ error: 'Role names cannot contain @' }, 400)

  const db = getDb(c.env.DB)

  const existing = await db
    .select({ id: roles.id, deletedAt: roles.deletedAt })
    .from(roles)
    .where(eq(roles.id, roleId))
    .get()
  if (!existing || existing.deletedAt !== null) return c.json({ error: 'Role not found' }, 404)

  // Case-insensitive conflict check, excluding self
  const conflict = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(
      sql`lower(${roles.name}) = lower(${name})`,
      ne(roles.id, roleId),
      isNull(roles.deletedAt),
    ))
    .get()
  if (conflict) return c.json({ error: 'A role with this name already exists' }, 409)

  await db.update(roles).set({ name }).where(eq(roles.id, roleId))
  return c.json({ id: roleId, name })
})

// PUT /admin/members/:id/roles
adminApiRouter.put('/members/:id/roles', async (c) => {
  const targetId = c.req.param('id')
  const body = await c.req.json<{ roleIds?: string[] }>().catch(() => ({} as { roleIds?: string[] }))
  const roleIds = body.roleIds ?? []

  const db = getDb(c.env.DB)

  // Validate all roleIds exist and are not deleted
  if (roleIds.length > 0) {
    const found = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(inArray(roles.id, roleIds), isNull(roles.deletedAt)))
      .all()
    if (found.length !== roleIds.length) {
      return c.json({ error: 'One or more role IDs not found' }, 400)
    }
  }

  // Replace atomically: delete existing, insert new
  await db.delete(userRoles).where(eq(userRoles.userId, targetId))
  if (roleIds.length > 0) {
    await db.insert(userRoles).values(roleIds.map(roleId => ({ userId: targetId, roleId })))
  }

  return c.json({ ok: true })
})

// GET /admin/members/:id/auth-events
adminApiRouter.get('/members/:id/auth-events', async (c) => {
  const db = getDb(c.env.DB)
  const userId = c.req.param('id')
  const events = await db
    .select({
      id: authEvents.id,
      event: authEvents.event,
      reason: authEvents.reason,
      linkType: authEvents.linkType,
      provider: authEvents.provider,
      ipCountry: authEvents.ipCountry,
      userAgent: authEvents.userAgent,
      createdAt: authEvents.createdAt,
      messageId: authEvents.messageId,
    })
    .from(authEvents)
    .where(eq(authEvents.userId, userId))
    .orderBy(desc(authEvents.createdAt))
    .limit(50)
    .all()
  const member = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()
  let suppression: { suppressed: boolean | null; reason?: string; createdAt?: string } = { suppressed: null }
  try {
    const central = c.env.CENTRAL as { emailSuppression?: (email: string) => Promise<typeof suppression> } | undefined
    if (member?.email && central?.emailSuppression) suppression = await central.emailSuppression(member.email)
  } catch (e) { console.error('[auth-events] suppression lookup failed', e) }
  const sentMsgIds = events.filter(e => e.event === 'email_sent' && e.messageId).map(e => e.messageId as string)
  let delivery: Record<string, { status: string; isSpam: boolean; errorCause?: string; datetime?: string }> = {}
  try {
    const central = c.env.CENTRAL as { emailDeliveryStatus?: (ids: string[], since: string) => Promise<typeof delivery> } | undefined
    if (sentMsgIds.length && central?.emailDeliveryStatus) {
      const since = new Date(Date.now() - 31 * 86400_000).toISOString()
      delivery = await central.emailDeliveryStatus(sentMsgIds, since)
    }
  } catch (e) { console.error('[auth-events] delivery lookup failed', e) }
  return c.json({ events, suppression, delivery })
})

// GET /admin/unknown-login-attempts
adminApiRouter.get('/unknown-login-attempts', async (c) => {
  const db = getDb(c.env.DB)
  const attempts = await db
    .select({
      id: authEvents.id,
      email: authEvents.email,
      ipCountry: authEvents.ipCountry,
      userAgent: authEvents.userAgent,
      createdAt: authEvents.createdAt,
    })
    .from(authEvents)
    .where(eq(authEvents.event, 'link_requested_unknown'))
    .orderBy(desc(authEvents.createdAt))
    .limit(100)
    .all()
  return c.json({ attempts })
})

// DELETE /admin/roles/:id
adminApiRouter.delete('/roles/:id', async (c) => {
  const roleId = c.req.param('id')
  const currentUser = c.get('user')
  const db = getDb(c.env.DB)

  const existing = await db
    .select({ id: roles.id, deletedAt: roles.deletedAt })
    .from(roles)
    .where(eq(roles.id, roleId))
    .get()
  if (!existing || existing.deletedAt !== null) return c.json({ error: 'Role not found' }, 404)

  const now = nowDb()
  await db.update(roles).set({ deletedAt: now, deletedBy: currentUser.id }).where(eq(roles.id, roleId))
  await db.delete(userRoles).where(eq(userRoles.roleId, roleId))

  return new Response(null, { status: 204 })
})

const ALLOWED_CONFIG_KEYS = ['association_name', 'sync_frequency', 'keywords', 'org_noun', 'position_label', 'ai_context', 'relevance_question', 'tag_taxonomy', 'instance_preset', 'modules', 'mention_emails_enabled', 'new_match_min_relevance'] as const

// GET /admin/config
adminApiRouter.get('/config', async (c) => {
  const db = getDb(c.env.DB)
  await ensureInstancePreset(c.env, db)
  const rows = await db.select().from(associationConfig).all()
  const result: Record<string, unknown> = {}
  for (const row of rows) {
    if (!(ALLOWED_CONFIG_KEYS as readonly string[]).includes(row.key)) continue
    try {
      result[row.key] = JSON.parse(row.value)
    } catch {
      result[row.key] = row.value
    }
  }
  if (result.tag_taxonomy !== undefined) {
    result.tag_taxonomy = parseTaxonomyItems(result.tag_taxonomy)
  }
  const [matchedRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bills)
    .where(inArray(bills.matchType, ['keyword', 'manual']))
    .all()
  result.matched_bills_count = matchedRow?.count ?? 0
  const [prioritizedRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bills)
    .where(and(inArray(bills.matchType, ['keyword', 'manual']), isNotNull(bills.priority)))
    .all()
  result.prioritized_bills_count = prioritizedRow?.count ?? 0
  result.org_noun = resolveOrgNoun(
    typeof result.org_noun === 'string' ? result.org_noun : null,
    typeof result.position_label === 'string' ? result.position_label : null,
  )
  result.accountDeletionEnabled = await getAccountDeletionEnabled(db)
  return c.json(result)
})

// PUT /admin/deletion-policy — Owner-only master switch for hard account deletion
adminApiRouter.put('/deletion-policy', requireOwner, async (c) => {
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }))
  if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) is required' }, 400)
  const db = getDb(c.env.DB)
  await db.insert(associationConfig)
    .values({ key: ACCOUNT_DELETION_KEY, value: JSON.stringify(body.enabled) })
    .onConflictDoUpdate({ target: associationConfig.key, set: { value: sql`excluded.value` } })
  return c.json({ enabled: body.enabled })
})

// PUT /admin/config
adminApiRouter.put('/config', async (c) => {
  const body = await c
    .req
    .json<Record<string, unknown>>()
    .catch(() => ({} as Record<string, unknown>))

  const unknownKeys = Object.keys(body).filter(
    (k) => !(ALLOWED_CONFIG_KEYS as readonly string[]).includes(k),
  )
  if (unknownKeys.length > 0) {
    return c.json({ error: `Unknown config keys: ${unknownKeys.join(', ')}` }, 400)
  }

  // In demo mode, non-superadmins can ONLY toggle modules (so demo visitors
  // can experience the module system). All other config keys stay locked.
  if (c.env.DEMO_MODE === 'true') {
    const currentUser = c.get('user')
    if (!(await isSuperadminRequest(c))) {
      const nonModuleKeys = Object.keys(body).filter((k) => k !== 'modules')
      if (nonModuleKeys.length > 0) {
        return c.json({ error: 'Configuration is locked in demo mode' }, 403)
      }
    }
  }

  if ('modules' in body) {
    const m = body.modules
    if (m === null) {
      // null is allowed — it means "clear the modules row" (handled by existing logic below)
    } else if (typeof m !== 'object' || Array.isArray(m)) {
      return c.json({ error: 'modules must be an object' }, 400)
    } else {
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (typeof v === 'boolean') continue
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const obj = v as Record<string, unknown>
          if (typeof obj.enabled !== 'boolean') {
            return c.json({ error: `modules.${k}.enabled must be a boolean` }, 400)
          }
          if (obj.settings !== undefined && (typeof obj.settings !== 'object' || obj.settings === null || Array.isArray(obj.settings))) {
            return c.json({ error: `modules.${k}.settings must be an object` }, 400)
          }
          continue
        }
        return c.json({ error: `modules.${k} must be a boolean or { enabled, settings }` }, 400)
      }
    }
  }

  const db = getDb(c.env.DB)
  for (const key of Object.keys(body)) {
    if (body[key] === null) {
      await db.delete(associationConfig).where(eq(associationConfig.key, key))
    } else {
      const value = JSON.stringify(body[key])
      await db
        .insert(associationConfig)
        .values({ key, value })
        .onConflictDoUpdate({
          target: associationConfig.key,
          set: { value: sql`excluded.value` },
        })
    }
  }

  if ('keywords' in body) {
    // Await register so the subsequent keyword-resync sees updated central keyword_registry.
    // Adds ~200ms to the PUT response but eliminates the race condition.
    try {
      await registerWithCentral(c.env, db)
    } catch (err) {
      console.error('[admin/config] registerWithCentral failed:', err)
      // Don't fail the PUT — tenant config was saved. Central sync can be retried.
    }
  }

  return c.json({ ok: true })
})

// POST /admin/keyword-resync — re-run AI on tenant bills that newly match current keywords.
// Operates only on non-stub bills (those that have full text in central). Stubs that match
// new keywords are caught by the cron's next full pass, which routes through the ingestor to
// fetch text before running AI.
adminApiRouter.post('/keyword-resync', demoGuard, async (c) => {
  if (!c.env.BILL_QUEUE) return c.json({ error: 'Queue not configured' }, 503)
  const db = getDb(c.env.DB)

  const kwRow = await db.select().from(associationConfig).where(eq(associationConfig.key, 'keywords')).get()
  const keywords: string[] = kwRow ? JSON.parse(kwRow.value) : []
  if (keywords.length === 0) return c.json({ queued: 0, note: 'no keywords configured' })

  // Find unprocessed bills that now match keywords — queue them for AI processing
  const unprocessed = await db
    .select({ externalId: bills.externalId, title: bills.title, abstract: bills.abstract })
    .from(bills)
    .where(and(isNull(bills.aiProcessedAt), isNotNull(bills.externalId)))
    .all()

  const matching = unprocessed.filter(b =>
    matchesKeywords(`${b.title} ${b.abstract ?? ''}`, keywords)
  )

  const BATCH_SIZE = 100
  for (let i = 0; i < matching.length; i += BATCH_SIZE) {
    await c.env.BILL_QUEUE.sendBatch(
      matching.slice(i, i + BATCH_SIZE).map(b => ({
        body: { tenantId: c.env.TENANT_ID, billId: b.externalId!, forceAI: true },
      }))
    )
  }

  // Also call central to enrich stub bills that now match the new keyword list.
  // Central will promote match_type='keyword' on bill_tenants and route through the
  // ingestor (forceAI:true) so text is fetched and AI runs on full text. On any
  // failure (including 429 rate-limit) we just continue — the tenant-side queueing
  // above is independent and already happened.
  let centralResult: { newlyMatched: number; truncated: boolean } | null = null
  try {
    const res = await centralFetch(c.env, `/admin/sync-keywords/${c.env.TENANT_ID}`, {
      method: 'POST',
    })
    if (res.ok) {
      const json = await res.json() as { newlyMatched?: number; truncated?: boolean }
      centralResult = {
        newlyMatched: json.newlyMatched ?? 0,
        truncated: json.truncated ?? false,
      }
    } else {
      console.warn(`[keyword-resync] central sync-keywords returned ${res.status}`)
    }
  } catch (err) {
    console.error('[keyword-resync] central sync-keywords call failed:', err)
  }

  // ── Cleanup pass: demote or protect stale keyword matches ──
  const keywordBills = await db
    .select({ id: bills.id, externalId: bills.externalId, title: bills.title, abstract: bills.abstract })
    .from(bills)
    .where(and(eq(bills.matchType, 'keyword'), isNotNull(bills.externalId)))
    .all()

  const staleBills = keywordBills.filter(b =>
    !matchesKeywords(`${b.title} ${b.abstract ?? ''}`, keywords)
  )

  let demoted = 0
  let protectedAsManual = 0

  if (staleBills.length > 0) {
    // Query engagement for ALL keyword bills (no inArray — avoids D1 ~100 bind-param limit
    // when the stale set is large). Filter to stale subset in memory afterward.
    const engagedRows = await db
      .selectDistinct({ id: bills.id })
      .from(bills)
      .leftJoin(memberVotes, eq(memberVotes.billId, bills.id))
      .leftJoin(officialPositions, eq(officialPositions.billId, bills.id))
      .leftJoin(comments, and(eq(comments.billId, bills.id), isNull(comments.deletedAt)))
      .leftJoin(notes, and(eq(notes.billId, bills.id), ne(notes.content, '')))
      .where(and(
        eq(bills.matchType, 'keyword'),
        or(isNotNull(memberVotes.id), isNotNull(officialPositions.id), isNotNull(comments.id), isNotNull(notes.id)),
      ))
      .all()
    const engagedIds = new Set(engagedRows.map(r => r.id))

    const toManual = staleBills.filter(b => engagedIds.has(b.id))
    const toDemote = staleBills.filter(b => !engagedIds.has(b.id))

    const updateStmts = [
      ...toManual.map(b => db.update(bills).set({ matchType: 'manual' }).where(eq(bills.id, b.id))),
      ...toDemote.map(b => db.update(bills).set({ matchType: null }).where(eq(bills.id, b.id))),
    ]
    for (let i = 0; i < updateStmts.length; i += 100) {
      await db.batch(updateStmts.slice(i, i + 100) as [any, ...any[]])
    }

    demoted = toDemote.length
    protectedAsManual = toManual.length

    const centralUpdates: Array<{ externalId: string; matchType: 'manual' | null }> = [
      ...toManual.map(b => ({ externalId: b.externalId!, matchType: 'manual' as const })),
      ...toDemote.map(b => ({ externalId: b.externalId!, matchType: null })),
    ]
    try {
      const mtRes = await centralFetch(c.env, `/admin/update-bill-match-types/${c.env.TENANT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: centralUpdates }),
      })
      if (!mtRes.ok) console.warn(`[keyword-resync] central update-bill-match-types returned ${mtRes.status}`)
    } catch (err) {
      console.error('[keyword-resync] central update-bill-match-types failed:', err)
    }
  }

  return c.json({
    queued: matching.length,
    centralEnriched: centralResult?.newlyMatched ?? 0,
    centralTruncated: centralResult?.truncated ?? false,
    demoted,
    protectedAsManual,
  })
})

// POST /admin/keyword-resync-preview — dry-run of keyword-resync; returns counts with no DB writes.
// Accepts { keywords: string[] } in the body (the new/proposed keywords, not yet saved).
adminApiRouter.post('/keyword-resync-preview', async (c) => {
  const db = getDb(c.env.DB)
  const body = await c.req.json().catch(() => ({})) as { keywords?: string[] }
  const keywords: string[] = Array.isArray(body.keywords) ? body.keywords : []

  if (keywords.length === 0) return c.json({ wouldAdd: 0, wouldDemote: 0, wouldProtect: 0 })

  // wouldAdd: lightweight bills that are unprocessed and would now match
  const lightweightUnprocessed = await db
    .select({ title: bills.title, abstract: bills.abstract })
    .from(bills)
    .where(and(isNull(bills.aiProcessedAt), isNotNull(bills.externalId), isNull(bills.matchType)))
    .all()
  const wouldAdd = lightweightUnprocessed.filter(b =>
    matchesKeywords(`${b.title} ${b.abstract ?? ''}`, keywords)
  ).length

  // wouldDemote / wouldProtect: keyword bills that would no longer match
  const keywordBills = await db
    .select({ id: bills.id, title: bills.title, abstract: bills.abstract })
    .from(bills)
    .where(eq(bills.matchType, 'keyword'))
    .all()
  const staleBills = keywordBills.filter(b =>
    !matchesKeywords(`${b.title} ${b.abstract ?? ''}`, keywords)
  )

  let wouldDemote = 0
  let wouldProtect = 0

  if (staleBills.length > 0) {
    // Query engagement for ALL keyword bills (no inArray — avoids D1 ~100 bind-param limit).
    const engagedRows = await db
      .selectDistinct({ id: bills.id })
      .from(bills)
      .leftJoin(memberVotes, eq(memberVotes.billId, bills.id))
      .leftJoin(officialPositions, eq(officialPositions.billId, bills.id))
      .leftJoin(comments, and(eq(comments.billId, bills.id), isNull(comments.deletedAt)))
      .leftJoin(notes, and(eq(notes.billId, bills.id), ne(notes.content, '')))
      .where(and(
        eq(bills.matchType, 'keyword'),
        or(isNotNull(memberVotes.id), isNotNull(officialPositions.id), isNotNull(comments.id), isNotNull(notes.id)),
      ))
      .all()
    const engagedIds = new Set(engagedRows.map(r => r.id))
    wouldDemote = staleBills.filter(b => !engagedIds.has(b.id)).length
    wouldProtect = staleBills.filter(b => engagedIds.has(b.id)).length
  }

  return c.json({ wouldAdd, wouldDemote, wouldProtect })
})

// POST /admin/reprocess-bill/:externalId — reprocess a single bill, forcing AI re-run
adminApiRouter.post('/reprocess-bill/:externalId', demoGuard, async (c) => {
  if (!c.env.BILL_QUEUE) return c.json({ error: 'Queue not configured' }, 503)
  const externalId = decodeURIComponent(c.req.param('externalId'))
  await c.env.BILL_QUEUE.send({ tenantId: c.env.TENANT_ID, billId: externalId, forceAI: true, interactive: true })
  return c.json({ queued: 1 })
})

// POST /admin/refresh-metadata — refresh every bill's metadata from central without re-running AI
adminApiRouter.post('/refresh-metadata', demoGuard, async (c) => {
  if (!c.env.BILL_QUEUE) return c.json({ error: 'Queue not configured' }, 503)
  const db = getDb(c.env.DB)
  const rows = await db.select({ externalId: bills.externalId }).from(bills).where(isNotNull(bills.externalId)).all()
  const BATCH_SIZE = 100
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await c.env.BILL_QUEUE.sendBatch(
      rows.slice(i, i + BATCH_SIZE)
        .filter(r => r.externalId)
        .map(r => ({ body: { tenantId: c.env.TENANT_ID, billId: r.externalId!, metadataOnly: true } }))
    )
  }
  return c.json({ queued: rows.length })
})

// POST /admin/reprocess-llm-all?scope=all|prioritized — re-run AI on matched bills.
// scope=prioritized additionally restricts to bills with a priority set (high/medium/low).
adminApiRouter.post('/reprocess-llm-all', demoGuard, async (c) => {
  if (!c.env.BILL_QUEUE) return c.json({ error: 'Queue not configured' }, 503)
  const scope = c.req.query('scope') === 'prioritized' ? 'prioritized' : 'all'
  const db = getDb(c.env.DB)
  const conditions = [
    isNotNull(bills.externalId),
    inArray(bills.matchType, ['keyword', 'manual']),
  ]
  if (scope === 'prioritized') conditions.push(isNotNull(bills.priority))
  const rows = await db
    .select({ externalId: bills.externalId })
    .from(bills)
    .where(and(...conditions))
    .all()
  const BATCH_SIZE = 100
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await c.env.BILL_QUEUE.sendBatch(
      rows.slice(i, i + BATCH_SIZE)
        .filter(r => r.externalId)
        .map(r => ({ body: { tenantId: c.env.TENANT_ID, billId: r.externalId!, forceAI: true } }))
    )
  }
  return c.json({ queued: rows.length, scope })
})

// POST /admin/promote-bill/:billId — promote a stub bill to full tracking.
// Looks up the bill's externalId (e.g. 'legiscan:12345'), strips the prefix,
// and proxies to central /tenants/promote-bill/:tenantId/:billId.
adminApiRouter.post('/promote-bill/:billId', demoGuard, async (c) => {
  const billId = c.req.param('billId')
  const db = getDb(c.env.DB)

  const bill = await db.select({ externalId: bills.externalId })
    .from(bills)
    .where(eq(bills.id, billId))
    .get()
  if (!bill) return c.json({ error: 'bill not found' }, 404)
  if (!bill.externalId) {
    return c.json({ error: 'bill has no externalId' }, 400)
  }
  if (!bill.externalId.startsWith('legiscan:')) {
    return c.json({ error: 'bill is not a LegiScan-backed bill, cannot promote' }, 400)
  }
  const lsBillId = bill.externalId.slice('legiscan:'.length)

  const res = await centralFetch(c.env, `/tenants/promote-bill/${c.env.TENANT_ID}/${lsBillId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interactive: true }),
  })
  if (!res.ok) {
    const errText = await res.text()
    let centralError = 'unknown'
    try {
      const parsed = JSON.parse(errText) as { error?: string }
      if (parsed.error) centralError = parsed.error
    } catch {
      // body wasn't JSON; truncate to avoid leaking large HTML bodies
      centralError = errText.slice(0, 200)
    }
    return c.json({ error: `central promote failed: ${res.status} ${centralError}` }, 502)
  }

  const result = await res.json() as { ok?: boolean; matchType?: string }
  return c.json({ ok: true, billId, matchType: result.matchType })
})

// GET /admin/presets
adminApiRouter.get('/presets', async (c) => {
  return c.json(Object.values(PRESETS))
})

// POST /admin/apply-preset/:slug
adminApiRouter.post('/apply-preset/:slug', demoGuard, async (c) => {
  const slug = c.req.param('slug')
  if (!PRESETS[slug]) return c.json({ error: 'Unknown preset' }, 404)

  const db = getDb(c.env.DB)
  await applyPresetConfig(db, slug)

  let queuedForAi = 0
  if (c.env.BILL_QUEUE) {
    const eligible = await db
      .select({ externalId: bills.externalId })
      .from(bills)
      .where(and(isNotNull(bills.externalId), or(isNull(bills.tenantSummary), eq(bills.tenantSummary, ''))))
      .all()

    const queueable = eligible.filter((b) => b.externalId !== null)
    queuedForAi = queueable.length

    for (let i = 0; i < queueable.length; i += 100) {
      const batch = queueable.slice(i, i + 100).map((b) => ({
        body: { billId: Number(b.externalId!), source: 'reprocess' as const, changeHash: '', llmOnly: true },
      }))
      await c.env.BILL_QUEUE.sendBatch(batch)
    }
  }

  try {
    c.executionCtx.waitUntil(registerWithCentral(c.env, db).catch(console.error))
  } catch {
    registerWithCentral(c.env, db).catch(console.error)
  }

  return c.json({ ok: true, preset: slug, queuedForAi })
})

// POST /admin/clear-interactions
adminApiRouter.post('/clear-interactions', requireOwner, async (c) => {
  const db = getDb(c.env.DB)
  await db.delete(commentReactions)
  await db.delete(comments)
  await db.delete(memberVotes)
  await db.delete(officialPositions)
  await db.delete(notes)
  await db.update(bills).set({ priority: null })
  await db.delete(feedEvents)
  return c.json({ ok: true })
})

// POST /admin/register-with-central
adminApiRouter.post('/register-with-central', async (c) => {
  const db = getDb(c.env.DB)
  await registerWithCentral(c.env, db)
  return c.json({ ok: true })
})


