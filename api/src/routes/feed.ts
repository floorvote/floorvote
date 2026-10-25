import { Hono } from 'hono'
import { eq, desc, count, ne, and, or, sql, isNotNull, notInArray, inArray, type SQL } from 'drizzle-orm'
import { filedSlug } from '../lib/sessionSlug'
import { requireAuth } from '../middleware/auth'
import { getDb } from '../db/client'
import { feedEvents, bills, users } from '../db/schema'
import { LEGISLATIVE_EVENT_TYPES, NO_PRIORITY_UPDATES, PASSIVE_EVENT_TYPES } from '../../../shared/feedUtils'
import { nowDb } from '../lib/dbTime'
import { activeUser } from '../lib/accountDeletion'
import type { AppDb, AppEnv } from '../types'
import { groupHasPriority, loadGroupPriorities, priorityWorn } from '../lib/teamFields'
import { getNewMatchMinRelevance, loadUntriagedNewMatchGroups, untriagedNewMatch } from '../lib/newMatch'
import { defaultFeedShows, entryLeads, rowDays, rowPage, utcDay, type DayEntry, type RowBill } from '../lib/noPriorityRow'

export const feedRouter = new Hono<AppEnv>()

feedRouter.use('*', requireAuth)

feedRouter.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || 1))
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 20)))
  const offset = (page - 1) * limit

  const db = getDb(c.env.DB)
  const currentUser = c.get('user')

  // Default-feed visibility. Mirrors filterPriorityEvents (shared/feedUtils) at the
  // level that rule actually operates on — the bill/day group, not the lone event.
  // A day-group of a non-prioritized bill surfaces when it holds at least one
  // non-passive (engagement) event, and then the whole group surfaces, passive
  // events included.
  //
  // The EXISTS arm is what closes that gap. #54 moved this filter server-side to
  // keep pagination honest — a page of `limit` events must be `limit` visible
  // events — and did it with a per-event approximation: drop every passive event on
  // a non-prioritized bill. That also dropped the status change a member's comment
  // was *about*, leaving the comment stranded without the context that prompted it.
  //
  // Day boundaries: date() is UTC here, while the client groups by the viewer's
  // local day (dbTsToLocalDay), so near midnight the two can disagree. This is a
  // close superset of the client's rule, not an exact match. Feed.tsx still runs
  // filterPriorityEvents over the result, so where they differ the client is the
  // stricter of the two and drops the card — and because its pagination is driven
  // by visibleCount (groups that survive filtering) rather than raw event count,
  // that costs one more page fetch, never the short page #54 was about. Erring
  // toward a superset here is deliberate for that reason: the reverse — a server
  // stricter than the client — is unrecoverable downstream.
  //
  // A companion group is one policy (#381): it is prioritized when any member is
  // (the group's priority is the one set most recently on a member), and its
  // day-group holds the engagement events of every member, since the client
  // rolls the members' events into one card. The group's EXISTS arm follows the
  // plain one, and only a bill in a group reaches it.
  const passiveTypes = [...PASSIVE_EVENT_TYPES]
  const engagementOnDay = (siblingBills: SQL) => sql`EXISTS (
      SELECT 1 FROM feed_events sib
       WHERE ${siblingBills}
         AND sib.suppressed != 1
         AND date(sib.created_at) = date(${feedEvents.createdAt})
         AND sib.type NOT IN (${sql.join(passiveTypes.map((t) => sql`${t}`), sql`, `)})
    )`
  const defaultVisible = or(
    groupHasPriority(bills),
    notInArray(feedEvents.type, passiveTypes),
    engagementOnDay(sql`sib.bill_id = ${feedEvents.billId}`),
    and(
      isNotNull(bills.groupKey),
      engagementOnDay(sql`sib.bill_id IN (SELECT g.id FROM bills g WHERE g.group_key = ${bills.groupKey})`),
    ),
  )

  // activeUser is evaluated against the left-joined `users` row; events whose
  // userId doesn't match any user (e.g. the synthetic 'system' author) leave
  // users.deactivatedAt NULL, and isNull(NULL) is true — so those are unaffected.
  //
  // The bills join is a left join so an event with no bill (a bulk edit) still
  // returns: such a row has NULL bills columns, which defaultVisible treats as
  // visible when its type is not passive.
  //
  // The no-priority updates row is passive, so defaultVisible (and with it the
  // nav dot below) never admits it. The feed's list admits it by its own
  // rule instead, from the bills whose legislative events defaultVisible hides
  // (lib/noPriorityRow): on a day those make two or more entries, the row; on a
  // day they make one, that entry's updates, which the client draws as the
  // bill's card (#921). Never both, so the total counts each once. Those updates
  // are passive too, so they never move the dot either.
  //
  // There is one feed: this route reads no `scope` (the "All analyzed bills" one
  // is gone, #922), so a client that still sends the parameter gets this feed.
  const minRelevance = await getNewMatchMinRelevance(db)
  const baseWhere = and(ne(feedEvents.suppressed, true), activeUser, defaultFeedShows(defaultVisible, minRelevance))

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
        billGroupKey: bills.groupKey,
        billSession: bills.session,
        billSessionSlug: bills.sessionSlug,
        billState: bills.state,
        billMatchType: bills.matchType,
        billNewMatchAt: bills.newMatchAt,
        billTriagedAt: bills.triagedAt,
        billIsDraft: bills.isDraft,
        userId: feedEvents.userId,
        userName: users.name,
        userEmail: users.email,
        userTitle: users.title,
        metadata: feedEvents.metadata,
        createdAt: feedEvents.createdAt,
      })
      .from(feedEvents)
      .leftJoin(bills, eq(feedEvents.billId, bills.id))
      .leftJoin(users, eq(feedEvents.userId, users.id))
      .where(baseWhere)
      .orderBy(desc(sql`datetime(${feedEvents.createdAt})`))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ total: count() })
      .from(feedEvents)
      .leftJoin(bills, eq(feedEvents.billId, bills.id))
      .leftJoin(users, eq(feedEvents.userId, users.id))
      .where(baseWhere)
      .get(),
    // Nav-dot signal: newest activity the user hasn't done themselves AND that the
    // default Feed actually shows. Excluding the current user's own events
    // means your own actions never light the dot. It reuses defaultVisible above
    // rather than restating the rule, so the dot cannot light for an event the
    // feed hides — or stay dark for one the feed shows.
    db.select({ latestEventAt: sql<string | null>`max(datetime(${feedEvents.createdAt}))` })
      .from(feedEvents)
      .leftJoin(bills, eq(feedEvents.billId, bills.id))
      .leftJoin(users, eq(feedEvents.userId, users.id))
      .where(and(
        ne(feedEvents.suppressed, true),
        ne(feedEvents.userId, currentUser.id),
        defaultVisible,
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

  // A companion group's events wear the group's priority, whichever member holds it.
  const groupPriorities = await loadGroupPriorities(db, rows.map((r) => r.billGroupKey))

  // Whether a card is an untriaged new match, which an admin's card shows as the
  // amber "New · Set priority" dropdown. A group is triaged as one (see
  // loadUntriagedNewMatchGroups); a bill in no group reads its own columns.
  const newMatchGroups = await loadUntriagedNewMatchGroups(db, rows.map((r) => r.billGroupKey))
  const isNewMatch = (r: (typeof rows)[number]) => untriagedNewMatch({
    groupKey: r.billGroupKey, matchType: r.billMatchType, newMatchAt: r.billNewMatchAt, priority: r.billPriority, triagedAt: r.billTriagedAt,
  }, newMatchGroups)

  // The day's new-matches row names every matched bill, but a companion group is
  // one policy (#638), so it counts once: the row's `count` is its distinct cards.
  const matchCounts = await newMatchCounts(db, rows.filter((r) => r.type === 'new_matches'))

  // A worn priority per row: a companion group's events wear the group's.
  const wornPriority = (r: (typeof rows)[number]) =>
    priorityWorn({ priority: r.billPriority ?? null, groupKey: r.billGroupKey ?? null }, groupPriorities)

  // Each no-priority updates row's bills, resolved now for the whole page in
  // two queries, however many rows it holds: how many entries, the first two
  // for its chips, and the time of its newest update (lastAt), by which the
  // viewer's feed files it under their own day. The rest load on expand.
  //
  // The same read of the page's days marks the updates that stand in for a row
  // of one (#921): a legislative update on the one entry its UTC day's row
  // resolves to. The client draws them as that bill's card, where its rule for
  // the default feed would otherwise hide them, and they raise no banner.
  const rowSummaries = new Map<string, { count: number; firstBills: unknown[]; lastAt: string }>()
  const loneCards = new Set<string>()
  // A companion group's lone card is named by the group's lead (#945), which
  // need not be the member that moved: sent on each of its updates as groupLead.
  const loneLeads = new Map<string, RowBill>()
  const pageRows = rows.filter((x) => x.type === NO_PRIORITY_UPDATES)
  const loneCandidates = rows.filter((r) =>
    r.billId !== null && LEGISLATIVE_EVENT_TYPES.includes(r.type) && wornPriority(r) === null)
  if (pageRows.length > 0 || loneCandidates.length > 0) {
    const days = await rowDays(db, [...pageRows, ...loneCandidates].map((r) => utcDay(r.createdAt)), minRelevance)
    const loneEntries = new Map<string, DayEntry>()
    for (const r of loneCandidates) {
      const entries = days.get(utcDay(r.createdAt))?.entries ?? []
      if (entries.length === 1 && entries[0].memberIds.includes(r.billId!)) {
        loneCards.add(r.id)
        if (entries[0].key.startsWith('group:')) loneEntries.set(r.id, entries[0])
      }
    }
    // Each entry's chip is the bill it is named by: a group's lead, with the group's analysis.
    const firstEntries = (day: string) => (days.get(day)?.entries ?? []).slice(0, 2)
    const named = await entryLeads(db, [...pageRows.flatMap((r) => firstEntries(utcDay(r.createdAt))), ...loneEntries.values()])
    for (const [id, entry] of loneEntries) {
      const lead = named.get(entry.key)
      if (lead) loneLeads.set(id, lead)
    }
    for (const r of pageRows) {
      const day = days.get(utcDay(r.createdAt))
      // A row whose bills left it between the page's query and this one counts 0, which the client hides.
      rowSummaries.set(r.id, {
        count: day?.entries.length ?? 0,
        firstBills: firstEntries(utcDay(r.createdAt)).flatMap((e) => named.get(e.key) ?? []),
        lastAt: day?.lastAt ?? r.createdAt,
      })
    }
  }
  const metadataOf = (r: { id: string; metadata: string }): unknown => {
    const stored = JSON.parse(r.metadata) as object
    if (matchCounts.has(r.id)) return { ...stored, count: matchCounts.get(r.id) }
    if (rowSummaries.has(r.id)) return { ...stored, ...rowSummaries.get(r.id) }
    return stored
  }

  return c.json({
    events: rows.map((r) => ({
      id: r.id,
      type: r.type,
      billId: r.billId,
      // Empty for an event with no bill: FeedEvent keeps these as strings so
      // per-bill consumers need no null handling, and billId null is the signal.
      billNumber: r.billNumber ?? '',
      billTitle: r.billTitle || r.billAbstract || '',
      billSummary: r.billSummary ?? null,
      billPriority: wornPriority(r),
      billGroupKey: r.billGroupKey ?? null,
      billMatchType: r.billMatchType ?? null,
      billNewMatch: isNewMatch(r),
      billSessionSlug: filedSlug({ session: r.billSession, sessionSlug: r.billSessionSlug }),
      billState: r.billState ?? null,
      billIsDraft: r.billIsDraft ?? false,
      userId: r.userId,
      userName: r.userName || r.userEmail,
      userTitle: r.userTitle,
      metadata: metadataOf(r),
      noPriorityCard: loneCards.has(r.id),
      ...(loneLeads.has(r.id) ? { groupLead: loneLeads.get(r.id) } : {}),
      createdAt: r.createdAt,
    })),
    total: countRow?.total ?? 0,
    page,
    limit,
    latestEventAt: latestRow?.latestEventAt ?? null,
    lastSeenFeed: seenRow?.lastSeenFeed ?? null,
  })
})

// A page of the no-priority updates row's expanded list.
const ROW_PAGE = 50

// Each new-matches row's count of new matches: its bills, with the members of one
// companion group counted once. An id with no bill row (deleted since) counts as
// one, as it did before groups.
async function newMatchCounts(db: AppDb, rows: Array<{ id: string; metadata: string }>): Promise<Map<string, number>> {
  const named = new Map(rows.map((r) => {
    const ids = (JSON.parse(r.metadata) as { billIds?: unknown }).billIds
    return [r.id, Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []] as const
  }))
  const allIds = [...new Set([...named.values()].flat())]
  const groupOf = new Map<string, string | null>()
  // D1 rejects more than 100 bound parameters per statement.
  for (let i = 0; i < allIds.length; i += 90) {
    for (const b of await db.select({ id: bills.id, groupKey: bills.groupKey }).from(bills).where(inArray(bills.id, allIds.slice(i, i + 90))).all()) {
      groupOf.set(b.id, b.groupKey)
    }
  }
  return new Map([...named].map(([id, ids]) => [id, new Set(ids.map((b) => groupOf.get(b) ? `group:${groupOf.get(b)}` : b)).size]))
}

feedRouter.post('/seen', async (c) => {
  const user = c.get('user')
  const db = getDb(c.env.DB)
  await db
    .update(users)
    .set({ lastSeenFeed: nowDb() })
    .where(eq(users.id, user.id))
  return c.body(null, 204)
})

// Bills a bill-less event is about, read from metadata.billIds. Fetched on demand
// when a Feed row is expanded rather than inlined in GET /feed: a bulk edit can name
// up to 1000 bills and the Feed polls page 1 every 20 seconds. Ids whose bill has
// since been deleted are skipped, so the list is what still exists. Each bill
// carries its AI summary and the priority it wears, for its chip's hover card.
//
// A no-priority updates row names no bills: its list is resolved now, from its
// day's events, by relevance, a page at a time (?page, ?limit, about 50 a page),
// each entry with its bills' changes that day and whether it reads as an untriaged
// new match. See lib/noPriorityRow. ?removed is how many entries the reader has
// dropped from the pages it already has (an admin set their priority): the row
// has shrunk by that many ahead of this page, so the page starts that much earlier
// and no entry slips past between two pages.
feedRouter.get('/events/:id/bills', async (c) => {
  const db = getDb(c.env.DB)
  const event = await db
    .select({ type: feedEvents.type, metadata: feedEvents.metadata, createdAt: feedEvents.createdAt })
    .from(feedEvents)
    .where(eq(feedEvents.id, c.req.param('id')))
    .get()
  if (!event) return c.json({ error: 'not found' }, 404)

  if (event.type === NO_PRIORITY_UPDATES) {
    const page = Math.max(1, Number(c.req.query('page') || 1) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || ROW_PAGE) || ROW_PAGE))
    const minRelevance = await getNewMatchMinRelevance(db)
    const day = utcDay(event.createdAt)
    const removedParam = c.req.query('removed') ?? ''
    const removed = /^\d+$/.test(removedParam) ? Number(removedParam) : 0
    const start = Math.max(0, (page - 1) * limit - removed)
    const entries = (await rowDays(db, [day], minRelevance)).get(day)?.entries ?? []
    return c.json({
      entries: await rowPage(db, day, minRelevance, entries.slice(start, start + limit)),
      total: entries.length,
      page,
      limit,
      hasMore: start + limit < entries.length,
    })
  }

  const named = (JSON.parse(event.metadata) as { billIds?: unknown }).billIds
  const ids = Array.isArray(named) ? named.filter((x): x is string => typeof x === 'string') : []

  const byId = new Map<string, typeof found[number]>()
  const found: Array<{
    id: string; billNumber: string; title: string; abstract: string | null
    state: string; session: string | null; sessionSlug: string | null; isDraft: boolean; groupKey: string | null
    summary: string | null; priority: 'high' | 'medium' | 'low' | null
  }> = []
  // D1 rejects more than 100 bound parameters per statement.
  for (let i = 0; i < ids.length; i += 90) {
    found.push(...await db
      .select({
        id: bills.id, billNumber: bills.billNumber, title: bills.title, abstract: bills.abstract,
        state: bills.state, session: bills.session, sessionSlug: bills.sessionSlug, isDraft: bills.isDraft, groupKey: bills.groupKey,
        summary: bills.tenantSummary, priority: bills.priority,
      })
      .from(bills)
      .where(inArray(bills.id, ids.slice(i, i + 90)))
      .all())
  }
  for (const b of found) byId.set(b.id, b)
  // What a chip's hover card shows, as the sidebar's does: the bill's AI summary,
  // and the priority it wears (its group's, when it is in one).
  const groupPriorities = await loadGroupPriorities(db, found.map((b) => b.groupKey))

  return c.json({
    bills: ids.flatMap((id) => {
      const b = byId.get(id)
      return b ? [{
        id: b.id,
        billNumber: b.billNumber,
        title: b.title || b.abstract || '',
        state: b.state ?? null,
        sessionSlug: filedSlug(b),
        isDraft: b.isDraft ?? false,
        groupKey: b.groupKey ?? null,
        summary: b.summary ?? null,
        priority: priorityWorn({ priority: b.priority ?? null, groupKey: b.groupKey ?? null }, groupPriorities),
      }] : []
    }),
  })
})
