import { Hono } from 'hono'
import { eq, desc, count, ne, and, or, sql, isNotNull, notInArray } from 'drizzle-orm'
import { sessionToSlug } from '../lib/sessionSlug'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { feedEvents, bills, users } from '../db/schema'
import { PASSIVE_EVENT_TYPES } from '../../../shared/feedUtils'
import { nowDb } from '../lib/dbTime'
import { activeUser } from '../lib/accountDeletion'
import type { AppEnv } from '../types'

export const feedRouter = new Hono<AppEnv>()

feedRouter.use('*', requireAuth)

feedRouter.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || 1))
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 20)))
  const offset = (page - 1) * limit
  const scope = c.req.query('scope') as 'default' | 'analyzed' | undefined

  const db = getDb(c.env.DB)
  const currentUser = c.get('user')

  // activeUser is evaluated against the left-joined `users` row; events whose
  // userId doesn't match any user (e.g. the synthetic 'system' author) leave
  // users.deactivatedAt NULL, and isNull(NULL) is true — so those are unaffected.
  const baseWhere = scope === 'analyzed'
    ? and(ne(feedEvents.suppressed, true), isNotNull(bills.matchType), activeUser)
    : and(ne(feedEvents.suppressed, true), activeUser)

  const [rows, countRow, latestRow, seenRow] = await Promise.all([
    db
      .select({
        id: feedEvents.id,
        type: feedEvents.type,
        billId: feedEvents.billId,
        billNumber: bills.billNumber,
        billTitle: bills.title,
        billAbstract: bills.abstract,
        billSummary: bills.tenantSummary,
        billPriority: bills.priority,
        billSession: bills.session,
        billState: bills.state,
        billMatchType: bills.matchType,
        userId: feedEvents.userId,
        userName: users.name,
        userEmail: users.email,
        userSubtitle: users.subtitle,
        metadata: feedEvents.metadata,
        createdAt: feedEvents.createdAt,
      })
      .from(feedEvents)
      .innerJoin(bills, eq(feedEvents.billId, bills.id))
      .leftJoin(users, eq(feedEvents.userId, users.id))
      .where(baseWhere)
      .orderBy(desc(sql`datetime(${feedEvents.createdAt})`))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: count() })
      .from(feedEvents)
      .innerJoin(bills, eq(feedEvents.billId, bills.id))
      .leftJoin(users, eq(feedEvents.userId, users.id))
      .where(baseWhere)
      .get(),
    // Nav-dot signal: newest activity the user hasn't done themselves AND that the
    // default Feed actually shows. Excluding the current user's own events
    // means your own actions never light the dot. The priority/passive predicate
    // mirrors filterPriorityEvents (shared/feedUtils) so the dot can't light for
    // passive provider updates on non-prioritized bills, which the feed hides.
    db.select({ latestEventAt: sql<string | null>`max(datetime(${feedEvents.createdAt}))` })
      .from(feedEvents)
      .innerJoin(bills, eq(feedEvents.billId, bills.id))
      .leftJoin(users, eq(feedEvents.userId, users.id))
      .where(and(
        ne(feedEvents.suppressed, true),
        ne(feedEvents.userId, currentUser.id),
        or(isNotNull(bills.priority), notInArray(feedEvents.type, [...PASSIVE_EVENT_TYPES])),
        activeUser,
      ))
      .get(),
    // Current user's seen baseline, so other open windows can clear the nav dot
    // once this user reads Feed anywhere (the 20s poll adopts the newer value).
    db.select({ lastSeenFeed: users.lastSeenFeed })
      .from(users)
      .where(eq(users.id, currentUser.id))
      .get(),
  ])

  return c.json({
    events: rows.map((r) => ({
      id: r.id,
      type: r.type,
      billId: r.billId,
      billNumber: r.billNumber,
      billTitle: r.billTitle || r.billAbstract,
      billSummary: r.billSummary ?? null,
      billPriority: r.billPriority ?? null,
      billMatchType: r.billMatchType ?? null,
      billSessionSlug: r.billSession ? sessionToSlug(r.billSession) : null,
      billState: r.billState ?? null,
      userId: r.userId,
      userName: r.userName || r.userEmail,
      userSubtitle: r.userSubtitle,
      metadata: JSON.parse(r.metadata) as unknown,
      createdAt: r.createdAt,
    })),
    total: countRow?.total ?? 0,
    page,
    limit,
    latestEventAt: latestRow?.latestEventAt ?? null,
    lastSeenFeed: seenRow?.lastSeenFeed ?? null,
  })
})

feedRouter.post('/seen', async (c) => {
  const user = c.get('user')
  const db = getDb(c.env.DB)
  await db
    .update(users)
    .set({ lastSeenFeed: nowDb() })
    .where(eq(users.id, user.id))
  return c.body(null, 204)
})
