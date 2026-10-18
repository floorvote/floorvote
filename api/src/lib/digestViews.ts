import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { bills, feedEvents, savedViews, savedViewSubscriptions, users } from '../db/schema'
import { buildBillsFilter, parseBillFilterParams } from '../routes/billsApi/query'
import { isPerUserListRequest } from './listCache'
import { activeUser } from './accountDeletion'
import { digestCardKey, type DigestEvent, type NewMatchDigestItem, type ViewDigestSection } from './digestEmail'
import { userDisplayNameSql } from './displayName'
import type { AppDb } from '../types'

/** The feed events the digest reports: what happened on a bill. Shared with the priority section. */
export const DIGEST_CATEGORIES = ['bill_updated', 'hearing_added', 'hearing_changed', 'hearing_cancelled', 'position_set', 'comment_added', 'priority_set']

type SubscribedView = { id: string; name: string; slug: string | null; query: string }

/** Every view a member among `userIds` has included in their digest, in the views' display order, with who included it. */
export async function loadViewSubscriptions(db: AppDb, userIds: readonly string[]): Promise<{ views: SubscribedView[]; byUser: Map<string, string[]> }> {
  if (userIds.length === 0) return { views: [], byUser: new Map() }
  const rows = await db
    .select({ userId: savedViewSubscriptions.userId, id: savedViews.id, name: savedViews.name, slug: savedViews.slug, query: savedViews.query })
    .from(savedViewSubscriptions)
    .innerJoin(savedViews, eq(savedViewSubscriptions.viewId, savedViews.id))
    .orderBy(asc(savedViews.displayOrder), asc(savedViews.id))
    .all()
  const wanted = new Set(userIds)
  const views = new Map<string, SubscribedView>()
  const byUser = new Map<string, string[]>()
  for (const r of rows) {
    if (!wanted.has(r.userId)) continue
    views.set(r.id, { id: r.id, name: r.name, slug: r.slug, query: r.query })
    byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.id])
  }
  return { views: [...views.values()], byUser }
}

/**
 * What is new in one view in the digest's window: the activity on the bills that meet its filter, and the bills
 * that entered the instance in the window and meet it (drafts are the author's own and never listed).
 *
 * The filter is read from the view's stored query by `parseBillFilterParams`, the function the bill list reads its
 * own with, and built by `buildBillsFilter`, so a view lists what the list shows for it. `userId` is whose "my bills"
 * and "unvoted" the filter means. A query that can't be read (an over-cap subject filter) lists nothing.
 */
async function loadViewNews(
  db: AppDb, view: SubscribedView, userId: string, since: string, now: string,
): Promise<{ events: DigestEvent[]; newBills: NewMatchDigestItem[] } | null> {
  const parsed = await parseBillFilterParams(db, new URLSearchParams(view.query), userId)
  if ('error' in parsed) return null
  const filter = (await buildBillsFilter(db, parsed.params))(bills)

  const events = await db
    .select({
      type: feedEvents.type, metadata: feedEvents.metadata, createdAt: feedEvents.createdAt,
      billId: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, billSession: bills.session, billSessionSlug: bills.sessionSlug, priority: bills.priority,
      summary: bills.tenantSummary, billIsDraft: bills.isDraft, billGroupKey: bills.groupKey,
      userName: userDisplayNameSql,
    })
    .from(feedEvents)
    .innerJoin(bills, eq(feedEvents.billId, bills.id))
    .leftJoin(users, eq(feedEvents.userId, users.id))
    .where(and(
      filter,
      inArray(feedEvents.type, DIGEST_CATEGORIES as any),
      sql`datetime(${feedEvents.createdAt}) > datetime(${since})`,
      sql`datetime(${feedEvents.createdAt}) <= datetime(${now})`,
      eq(feedEvents.suppressed, false),
      activeUser,
    ))
    .all()

  const newBills = await db
    .select({
      billId: bills.id, billNumber: bills.billNumber, billTitle: bills.title,
      billState: bills.state, billSession: bills.session, billSessionSlug: bills.sessionSlug, relevanceScore: bills.relevanceScore,
      summary: bills.tenantSummary, billGroupKey: bills.groupKey,
    })
    .from(bills)
    .where(and(
      filter,
      eq(bills.isDraft, false),
      sql`datetime(${bills.createdAt}) > datetime(${since})`,
      sql`datetime(${bills.createdAt}) <= datetime(${now})`,
    ))
    .all()

  return { events: events as DigestEvent[], newBills }
}

/**
 * The view sections of each subscriber's digest. A bill the digest already shows as a priority bill (`shownKeys`,
 * its card keys) is left out of the views, so it appears once, under priority bills. A view whose filter is the
 * same for every member (most are) is read once. One that depends on the member (my bills, unvoted) is read per member.
 */
export async function buildViewSections(
  db: AppDb,
  opts: { userIds: readonly string[]; since: string; now: string; shownKeys: ReadonlySet<string> },
): Promise<Map<string, ViewDigestSection[]>> {
  const { views, byUser } = await loadViewSubscriptions(db, opts.userIds)
  const sections = new Map<string, ViewDigestSection[]>()
  if (views.length === 0) return sections

  const byId = new Map(views.map(v => [v.id, v]))
  const news = new Map<string, Promise<{ events: DigestEvent[]; newBills: NewMatchDigestItem[] } | null>>()
  const newsFor = (view: SubscribedView, userId: string) => {
    const params = new URLSearchParams(view.query)
    const perUser = isPerUserListRequest({ myBills: params.get('myBills') ?? undefined, unvoted: params.get('unvoted') ?? undefined })
    const key = perUser ? `${view.id}:${userId}` : view.id
    if (!news.has(key)) news.set(key, loadViewNews(db, view, userId, opts.since, opts.now))
    return news.get(key)!
  }

  for (const [userId, viewIds] of byUser) {
    const own: ViewDigestSection[] = []
    for (const id of viewIds) {
      const view = byId.get(id)!
      const found = await newsFor(view, userId)
      if (!found) continue
      const events = found.events.filter(e => !opts.shownKeys.has(digestCardKey(e)))
      const newBills = found.newBills.filter(b => !opts.shownKeys.has(b.billGroupKey ? `group:${b.billGroupKey}` : b.billId))
      if (events.length === 0 && newBills.length === 0) continue
      own.push({ viewId: view.id, name: view.name, slug: view.slug ?? view.id, events, newBills })
    }
    if (own.length > 0) sections.set(userId, own)
  }
  return sections
}
