import { eq, and, or, inArray, sql, desc, isNull } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { rowidOf } from '../../db/rowid'
import {
  bills, comments, users, commentReactions, feedEvents,
  billTexts, roles, userRoles, teamEvents, billMutes,
} from '../../db/schema'
import type { Env } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { isHandle, toHandle } from '../../../../shared/billHandle'
import { isRelationshipKind, type RelationshipKind } from '../../../../shared/relationshipKinds'
import type { BillExtras } from '../../../../shared/providerExtras'
import { dbTsToEpoch } from '../../../../shared/time'
import { billSlug, filedSlug } from '../../lib/sessionSlug'
import { loadDemoBillCalendar } from '../../lib/demoCalendar'
import { activeUser } from '../../lib/accountDeletion'
import { loadTaxonomyTagNameSet, filterTagsToTaxonomy } from '../../lib/taxonomy'
import { parseSubjects, loadSuppressedSubjectStates, isSubjectsSuppressedForState } from '../../lib/billSubjects'
import { displayName, userDisplayNameSql } from '../../lib/displayName'
import { titleOf, userTitleSql } from '../../lib/userTitle'
import { groupMemberIds, groupVotes, inGroupOf, loadGroupBills, loadGroupNotes, mergeGroupNotes } from '../../lib/companionGroups'
import { loadGroupTeamValues } from '../../lib/teamFields'
import type { GroupingEvent, GroupingEventMetadata, GroupingEventType } from '../../../../shared/companionGroups'

type CentralBillRich = {
  billType?: string | null
  body?: string | null
  statusDate?: string | null
  legiscanUrl?: string | null
  sponsors?: Array<{ name: string; party: string | null; role: string | null; primary: boolean; personId: string | null; url: string | null }>
  votes?: Array<{ id: string; motionText: string; date: string; result: string; chamber: string; counts: Array<{ option: string; value: number }>; legislatorVotes?: Array<{ personId: string; name: string; vote: string }> }>
  relatedBills?: Array<{ identifier: string; sastBillId?: number; session: string; relationType: string; kind?: string }>
  calendar?: Array<{ eventHash: string; typeId: number; type: string; kind?: string | null; date: string; time: string | null; location: string | null; description: string | null }>
  supplements?: Array<{ supplementId: number; typeId: number; type: string; date: string | null; dateResolved: string | null; dateInferred: boolean; title: string | null; description: string | null; mime: string | null; url: string | null; stateLink: string | null }>
  amendments?: Array<{
    amendmentId: number
    adopted: boolean
    chamber: string | null
    date: string | null
    dateResolved: string | null
    dateInferred: boolean
    title: string | null
    description: string | null
    mime: string | null
    url: string | null
    stateLink: string | null
  }>
  /** Fields only the bill's provider publishes, labeled by central. Display only. */
  extras?: BillExtras | null
  /** The committee the bill is pending in, and its referrals, each named by central's committee row. */
  committee?: { committeeId: string; name: string; chamber: string | null } | null
  referrals?: Array<{ date: string | null; committeeId: string | null; name: string; chamber: string | null }>
}

/**
 * When each of these bills first had a comment the thread would show, as an epoch. A bill with none is absent.
 * Timestamps come in two shapes (see dbTsToEpoch), so the earliest is found here rather than in SQL.
 */
async function firstCommentTimes(db: ReturnType<typeof getDb>, billIds: string[]): Promise<Map<string, number>> {
  const first = new Map<string, number>()
  if (billIds.length === 0) return first
  const rows = await db.select({ billId: comments.billId, createdAt: comments.createdAt })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(and(inArray(comments.billId, [...new Set(billIds)]), isNull(comments.deletedAt), activeUser))
    .all()
  for (const r of rows) {
    const at = dbTsToEpoch(r.createdAt)
    if (at < (first.get(r.billId) ?? Infinity)) first.set(r.billId, at)
  }
  return first
}

export async function buildBillDetail(
  db: ReturnType<typeof getDb>,
  billId: string,
  currentUser: { id: string; role: string },
  env: Env,
): Promise<Record<string, unknown>> {
  const bill = await db.select().from(bills).where(eq(bills.id, billId)).get()
  if (!bill) throw new Error('Not found')

  const tagSet = await loadTaxonomyTagNameSet(db)
  const suppressedSubjectStates = await loadSuppressedSubjectStates(db)
  const subjectsSuppressed = isSubjectsSuppressedForState(suppressedSubjectStates, bill.state)

  // Fetch rich supplemental data from central for LegiScan bills (calendar, supplements, votes, etc.)
  // Purely a read — no queue messages, no API calls, no AI.
  let centralRich: CentralBillRich | null = null
  if (isHandle(bill.externalId)) {
    try {
      const res = await centralFetch(env, `/bills/${bill.externalId}`)
      if (res.ok) centralRich = await res.json() as CentralBillRich
    } catch {
      // Non-fatal — bill detail still works without the supplemental data
    }
  }

  // A bill's companion group shares its conversation, votes, and notes, and
  // each read below resolves across the group (lib/companionGroups.ts). For an
  // ungrouped bill the group is the bill alone.
  const votes = groupVotes(db, billId)
  const [groupBills, myVoteRow, myNotes, myMuteRow, teamValues, voteRows, commentRows, commentCountRow, textRows, priorityEventRow, groupingRows] = await Promise.all([
    loadGroupBills(db, billId),
    db.select({ position: votes.position }).from(votes).where(eq(votes.userId, currentUser.id)).get(),
    loadGroupNotes(db, billId, currentUser.id),
    // Muting any bill in the group mutes its one conversation.
    db.select({ userId: billMutes.userId }).from(billMutes)
      .where(and(inGroupOf(billMutes.billId, billId), eq(billMutes.userId, currentUser.id)))
      .get(),
    // The team fields (position, priority, custom fields, analysis, triage),
    // each the one set most recently on any member (lib/teamFields.ts).
    loadGroupTeamValues(db, billId),
    db.select({ position: votes.position })
      .from(votes)
      .innerJoin(users, eq(votes.userId, users.id))
      .where(and(eq(users.canVote, 1), activeUser))
      .all(),
    db.select({
        c: comments,
        userName: users.name,
        userEmail: users.email,
        userTitle: userTitleSql,
      })
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(and(inGroupOf(comments.billId, billId), isNull(comments.deletedAt), activeUser))
      // daysAgoDb truncates to seconds, so seeded comments sharing a daysAgo —
      // and a visitor's new comment landing the same second — collide on
      // created_at. rowid follows insert order, which is the intended reading
      // order for the seed's question/answer pairs.
      .orderBy(comments.createdAt, rowidOf(comments))
      .limit(20)
      .all(),
    db.select({ count: sql<number>`count(*)` })
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(and(inGroupOf(comments.billId, billId), isNull(comments.deletedAt), activeUser))
      .get(),
    db.select().from(billTexts).where(eq(billTexts.billId, billId)).orderBy(desc(billTexts.date)).all(),
    db.select({ setByName: userDisplayNameSql, createdAt: feedEvents.createdAt })
      .from(feedEvents)
      .innerJoin(users, eq(feedEvents.userId, users.id))
      // A bulk priority edit is a bill-less event that lists its bills in
      // metadata.billIds. The group's priority may have been set on any member.
      .where(and(
        or(
          inGroupOf(feedEvents.billId, billId),
          and(
            isNull(feedEvents.billId),
            sql`EXISTS (SELECT 1 FROM json_each(${feedEvents.metadata}, '$.billIds') WHERE value IN ${groupMemberIds(billId)})`,
          ),
        ),
        eq(feedEvents.type, 'priority_set'),
        activeUser,
      ))
      .orderBy(desc(feedEvents.createdAt))
      .limit(1)
      .get(),
    // This bill's own grouping events, for the lines its comment thread shows
    // where its group formed or split. A companion's are about the companion.
    db.select({ id: teamEvents.id, type: teamEvents.type, createdAt: teamEvents.createdAt, metadata: teamEvents.metadata, actorName: userDisplayNameSql })
      .from(teamEvents)
      .leftJoin(users, eq(teamEvents.actorUserId, users.id))
      .where(and(eq(teamEvents.billId, billId), inArray(teamEvents.type, ['grouped', 'split'] satisfies GroupingEventType[])))
      .orderBy(teamEvents.createdAt, rowidOf(teamEvents))
      .all(),
  ])
  const billNumberOf = new Map(groupBills.map(b => [b.billId, b.billNumber]))
  const groupingMeta = groupingRows.map(e => JSON.parse(e.metadata) as GroupingEventMetadata)
  // Which of the bills each event joined or left had a comment posted before it. The thread shows an
  // automatic grouping or split line only for that: those comments now appear here, or no longer do.
  // A comment counts when the thread would show it, so not a deleted one or a deactivated member's,
  // and a comment at the very second of the event counts as before it, since the thread sets it above the line.
  const firstComment = await firstCommentTimes(db, groupingMeta.flatMap(m => m.with.map(b => b.billId)))
  const groupingEvents: GroupingEvent[] = groupingRows.map((e, i) => ({
    id: e.id,
    type: e.type as GroupingEventType,
    createdAt: e.createdAt,
    // Null when FloorVote grouped the bills itself.
    actorName: e.actorName ?? null,
    with: groupingMeta[i].with,
    commentBills: groupingMeta[i].with.filter(b => (firstComment.get(b.billId) ?? Infinity) <= dbTsToEpoch(e.createdAt)),
    replaced: groupingMeta[i].replaced ?? [],
    ...(groupingMeta[i].undoneSplits?.length ? { undoneSplits: groupingMeta[i].undoneSplits } : {}),
  }))

  const voteCounts = { support: 0, oppose: 0, neutral: 0, total: 0 }
  for (const v of voteRows) {
    voteCounts[v.position]++
    voteCounts.total++
  }

  const commentIds = commentRows.map((r) => r.c.id)
  const reactionRows = commentIds.length > 0
    ? await db.select({ reaction: commentReactions, user: users })
        .from(commentReactions)
        .innerJoin(users, eq(commentReactions.userId, users.id))
        .where(and(inArray(commentReactions.commentId, commentIds), isNull(commentReactions.deletedAt), activeUser))
        .all()
    : []

  const reactionsByComment = new Map<string, Map<string, { count: number; userReacted: boolean; reactors: { name: string; title: string | null; subtitle: string | null }[] }>>()
  for (const { reaction: r, user: reactor } of reactionRows) {
    if (!reactionsByComment.has(r.commentId)) reactionsByComment.set(r.commentId, new Map())
    const emojiMap = reactionsByComment.get(r.commentId)!
    if (!emojiMap.has(r.emoji)) emojiMap.set(r.emoji, { count: 0, userReacted: false, reactors: [] })
    const entry = emojiMap.get(r.emoji)!
    entry.count++
    // `subtitle` is the old name for `title`. Remove in the release after this one.
    entry.reactors.push({ name: displayName(reactor), title: titleOf(reactor), subtitle: titleOf(reactor) })
    if (r.userId === currentUser.id) entry.userReacted = true
  }

  const formattedComments = commentRows.map(({ c: comment, userName, userEmail, userTitle }) => ({
    id: comment.id,
    // The bill the comment was posted on, which in a group may be a companion.
    billId: comment.billId,
    billNumber: billNumberOf.get(comment.billId) ?? bill.billNumber,
    userId: comment.userId,
    userName: userName || userEmail,
    userTitle,
    // `subtitle` is the old name for `title`. Remove in the release after this one.
    userSubtitle: userTitle,
    content: comment.content,
    createdAt: comment.createdAt,
    reactions: Array.from(reactionsByComment.get(comment.id)?.entries() ?? []).map(
      ([emoji, data]) => ({ emoji, count: data.count, userReacted: data.userReacted, reactors: data.reactors }),
    ),
  }))

  const positionRow = teamValues.position
  let positionWithName: { position: string; setByName: string; updatedAt: string } | null = null
  if (positionRow) {
    const setter = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, positionRow.setBy)).get()
    positionWithName = {
      position: positionRow.position,
      setByName: setter ? displayName(setter) : 'Unknown',
      updatedAt: positionRow.updatedAt,
    }
  }

  // Resolve related bills using central SAST data when available; fall back to stored JSON
  // `type` is the legislature's own label as a slug, and `kind` is what central's vocabulary makes of it.
  type ResolvedRelated = { billId: number; billNumber: string; type: string; kind: RelationshipKind; route: { id: string; billNumber: string; sessionSlug: string; state: string } | null }
  let resolvedRelated: ResolvedRelated[] = []
  if (centralRich?.relatedBills?.length) {
    const externalIds = centralRich.relatedBills
      .flatMap(r => r.sastBillId != null ? [toHandle(r.sastBillId)] : [])
    const internalRows = externalIds.length > 0
      ? await db.select({ id: bills.id, externalId: bills.externalId, billNumber: bills.billNumber, session: bills.session, sessionSlug: bills.sessionSlug, state: bills.state })
          .from(bills)
          .where(inArray(bills.externalId, externalIds))
          .all()
      : []
    const routeByExternal = new Map(internalRows.map(r => [r.externalId, { id: r.id, billNumber: r.billNumber, sessionSlug: filedSlug(r) ?? '', state: r.state }]))
    resolvedRelated = centralRich.relatedBills.map(r => ({
      billId: r.sastBillId ?? 0,
      billNumber: r.identifier,
      type: r.relationType,
      // A central that predates kinds sends none, and a bill is then only related.
      kind: isRelationshipKind(r.kind) ? r.kind : 'related',
      route: r.sastBillId != null ? (routeByExternal.get(toHandle(r.sastBillId)) ?? null) : null,
    }))
  } else {
    // Fallback: stored JSON may be an array of bill-number strings (legacy format)
    const stored = bill.relatedBillIds ? JSON.parse(bill.relatedBillIds) as unknown : []
    if (Array.isArray(stored)) {
      resolvedRelated = (stored as string[]).map(identifier => ({
        billId: 0,
        billNumber: String(identifier),
        type: 'related',
        kind: 'related',
        route: null,
      }))
    }
  }

  // The bill the shown analysis comes from: this bill's own unless its group
  // shows a tracked member's (#554). Regenerate re-analyzes it and polls its
  // analysis time (#563), so the page needs its handle and where its analysis
  // stands, which on a companion's page are not the page bill's own.
  const analysisBillId = teamValues.analysis?.billId ?? bill.id
  const analysisBill = analysisBillId === bill.id
    ? bill
    : (await db.select({
        id: bills.id, externalId: bills.externalId, billNumber: bills.billNumber,
        aiProcessedAt: bills.aiProcessedAt, aiSkipReason: bills.aiSkipReason, textStatus: bills.textStatus,
      }).from(bills).where(eq(bills.id, analysisBillId)).get()) ?? bill

  const response: Record<string, unknown> = {
    id: bill.id,
    externalId: bill.externalId,
    billNumber: bill.billNumber,
    title: bill.title,
    state: bill.state,
    status: bill.status,
    session: bill.session,
    sessionSlug: billSlug(bill),
    sessionId: bill.sessionId,
    yearStart: bill.yearStart ?? null,
    yearEnd: bill.yearEnd ?? null,
    abstract: bill.abstract,
    url: bill.url,
    stateUrl: bill.stateUrl,
    stateLink: bill.stateLink,
    legiscanUrl: centralRich?.legiscanUrl ?? null,
    billType: centralRich?.billType ?? null,
    body: centralRich?.body ?? null,
    // Central's committee when it has one. Only demo seeds fill bills.committee, and a name has no id or chamber.
    committee: centralRich?.committee ?? (bill.committee ? { committeeId: null, name: bill.committee, chamber: null } : null),
    referrals: centralRich?.referrals ?? [],
    // The group's analysis: its most recently analyzed tracked member's, or any member's when none tracked has one.
    tenantSummary: teamValues.analysis ? teamValues.analysis.tenantSummary : bill.tenantSummary,
    tags: filterTagsToTaxonomy(teamValues.analysis ? teamValues.analysis.tags : JSON.parse(bill.tags) as string[], tagSet),
    relevanceScore: bill.relevanceScore,
    priority: teamValues.priority?.priority ?? null,
    priorityMeta: priorityEventRow ? { setByName: priorityEventRow.setByName, updatedAt: priorityEventRow.createdAt } : null,
    sponsor: bill.sponsor,
    sponsorParty: bill.sponsorParty,
    sponsorUrl: centralRich?.sponsors?.find(s => s.primary)?.url ?? bill.sponsorUrl,
    coSponsors: centralRich?.sponsors
      ? (() => {
          // The primary sponsor shown in bill.sponsor is the first primary-flagged sponsor.
          // All others (including additional primary-flagged sponsors like co-primary sponsors
          // in NJ-style multi-primary bills) go into coSponsors, with primary:true preserved
          // so the UI can distinguish them from regular co-sponsors.
          const primaryName = bill.sponsor
          return centralRich.sponsors
            .filter(s => s.name !== primaryName)
            .map(s => ({ name: s.name, url: s.url ?? null, party: s.party ?? null, primary: s.primary ?? false }))
        })()
      : (bill.coSponsors ? JSON.parse(bill.coSponsors) : []),
    lastAction: bill.lastAction,
    lastActionDate: bill.lastActionDate,
    history: bill.history ? JSON.parse(bill.history) : [],
    relatedBillIds: resolvedRelated,
    matchType: bill.matchType,
    newMatchAt: bill.newMatchAt ?? null,
    // Triaging any member triages the group.
    triagedAt: teamValues.triaged?.triagedAt ?? null,
    isDraft: bill.isDraft,
    draftText: bill.draftText,
    textR2Key: bill.textR2Key,
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
    centralSyncedAt: bill.centralSyncedAt ?? null,
    aiProcessedAt: bill.aiProcessedAt ?? null,
    aiSkipReason: bill.aiSkipReason ?? null,
    lastAiTextDocId: bill.lastAiTextDocId,
    // Where the analysis shown above stands: the page bill's own fields in no
    // group or on a tracked bill's page, the tracked bill's on a companion's.
    analysisBillId: analysisBill.id,
    analysisBillExternalId: analysisBill.externalId ?? null,
    analysisBillNumber: analysisBill.billNumber,
    analysisAiProcessedAt: analysisBill.aiProcessedAt ?? null,
    analysisAiSkipReason: analysisBill.aiSkipReason ?? null,
    analysisTextStatus: analysisBill.textStatus ?? null,
    textStatus: bill.textStatus ?? null,
    myVote: myVoteRow?.position ?? null,
    // The member's notes across the group, and the one note they edit, which
    // holds them all under their bill numbers until the next save merges them.
    myNote: mergeGroupNotes(myNotes),
    myNotes,
    commentsMuted: !!myMuteRow,
    position: positionWithName,
    voteCounts,
    comments: formattedComments,
    commentsTotal: commentCountRow?.count ?? 0,
    groupingEvents,
    // The bills in its companion group, this one first: just this one in no group.
    groupBills,
    texts: textRows.map(t => ({
      docId: t.docId,
      type: t.type,
      date: t.date,
      mime: t.mime,
      stateLink: t.stateLink,
      altStateLink: t.altStateLink,
    })),
    voteSummary: centralRich?.votes?.map(v => ({
      date: v.date,
      chamber: v.chamber,
      desc: v.motionText,
      yea: v.counts.find(c => c.option === 'yes')?.value ?? 0,
      nay: v.counts.find(c => c.option === 'no')?.value ?? 0,
      nv: v.counts.find(c => c.option === 'not voting')?.value ?? 0,
      absent: v.counts.find(c => c.option === 'absent')?.value ?? 0,
      passed: v.result === 'pass' ? 1 : 0,
      legislatorVotes: v.legislatorVotes ?? [],
    })) ?? undefined,
    subjects: subjectsSuppressed ? [] : parseSubjects(bill.subjects),
    calendar: env.DEMO_MODE === 'true'
      ? await loadDemoBillCalendar(db, billId)
      : (centralRich?.calendar ?? []),
    amendments: centralRich?.amendments ?? [],
    supplements: centralRich?.supplements ?? [],
    // Passed through for the bill page's provider panel, never stored: nothing
    // in an instance sorts, filters, notifies, or runs AI on extras.
    extras: centralRich?.extras ?? null,
    customFieldValues: {} as Record<string, { value: string; setBy: string | null; updatedAt: string }>,
  }

  if (currentUser.role === 'admin' || currentUser.role === 'owner') {
    const memberVoteRows = await db
      .select({ userId: votes.userId, userName: users.name, userEmail: users.email, position: votes.position, votedAt: votes.updatedAt })
      .from(votes)
      .innerJoin(users, eq(votes.userId, users.id))
      .all()

    const voterIds = memberVoteRows.map((v) => v.userId)
    const roleRows = voterIds.length > 0
      ? await db
          .select({ userId: userRoles.userId, roleId: roles.id, roleName: roles.name })
          .from(userRoles)
          .innerJoin(roles, eq(userRoles.roleId, roles.id))
          .where(inArray(userRoles.userId, voterIds))
          .all()
      : []
    const rolesByUser = new Map<string, { id: string; name: string }[]>()
    for (const row of roleRows) {
      if (!rolesByUser.has(row.userId)) rolesByUser.set(row.userId, [])
      rolesByUser.get(row.userId)!.push({ id: row.roleId, name: row.roleName })
    }

    response.memberVotes = memberVoteRows.map((v) => ({
      userName: v.userName,
      userEmail: v.userEmail,
      position: v.position,
      votedAt: v.votedAt,
      roles: rolesByUser.get(v.userId) ?? [],
    }))
  }

  // Custom field values, each the group's, named by who set it. A value whose
  // setter no longer exists is left out, as it always was.
  const cfValues = [...teamValues.customFields.values()]
  const setterIds = [...new Set(cfValues.map(v => v.setBy))]
  const setterName = new Map(setterIds.length === 0 ? [] : (await db.select({ id: users.id, name: userDisplayNameSql })
    .from(users).where(inArray(users.id, setterIds)).all()).map(u => [u.id, u.name]))
  response.customFieldValues = Object.fromEntries(cfValues.flatMap(v => (setterName.has(v.setBy)
    ? [[v.fieldId, { value: v.value, setBy: setterName.get(v.setBy) ?? null, updatedAt: v.updatedAt }]]
    : [])))

  return response
}
