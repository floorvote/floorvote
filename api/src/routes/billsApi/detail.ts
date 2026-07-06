import { eq, and, inArray, sql, desc, isNull } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, officialPositions, comments, notes, users, commentReactions, feedEvents,
  billTexts, roles, userRoles, billCustomFieldValues,
} from '../../db/schema'
import type { Env } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { sessionToSlug } from '../../lib/sessionSlug'
import { loadDemoBillCalendar } from '../../lib/demoCalendar'

type CentralBillRich = {
  billType?: string | null
  body?: string | null
  statusDate?: string | null
  legiscanUrl?: string | null
  sponsors?: Array<{ name: string; party: string | null; role: string | null; primary: boolean; personId: string | null; url: string | null }>
  votes?: Array<{ id: string; motionText: string; date: string; result: string; chamber: string; counts: Array<{ option: string; value: number }> }>
  relatedBills?: Array<{ identifier: string; sastBillId?: number; session: string; relationType: string }>
  calendar?: Array<{ eventHash: string; typeId: number; type: string; date: string; time: string | null; location: string | null; description: string | null }>
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
  subjects?: string[]
}

export async function buildBillDetail(
  db: ReturnType<typeof getDb>,
  billId: string,
  currentUser: { id: string; role: string },
  env: Env,
): Promise<Record<string, unknown>> {
  const bill = await db.select().from(bills).where(eq(bills.id, billId)).get()
  if (!bill) throw new Error('Not found')

  // Fetch rich supplemental data from central for LegiScan bills (calendar, supplements, votes, etc.)
  // Purely a read — no queue messages, no API calls, no AI.
  let centralRich: CentralBillRich | null = null
  if (bill.externalId?.startsWith('legiscan:')) {
    try {
      const res = await centralFetch(env, `/bills/${bill.externalId}`)
      if (res.ok) centralRich = await res.json() as CentralBillRich
    } catch {
      // Non-fatal — bill detail still works without the supplemental data
    }
  }

  const [myVoteRow, myNoteRow, positionRow, voteRows, commentRows, commentCountRow, textRows, priorityEventRow] = await Promise.all([
    db.select().from(memberVotes)
      .where(and(eq(memberVotes.billId, billId), eq(memberVotes.userId, currentUser.id)))
      .get(),
    db.select().from(notes)
      .where(and(eq(notes.billId, billId), eq(notes.userId, currentUser.id)))
      .get(),
    db.select({ position: officialPositions.position, setBy: officialPositions.setBy, updatedAt: officialPositions.updatedAt })
      .from(officialPositions).where(eq(officialPositions.billId, billId)).get(),
    db.select({ position: memberVotes.position })
      .from(memberVotes)
      .innerJoin(users, eq(memberVotes.userId, users.id))
      .where(and(eq(memberVotes.billId, billId), eq(users.canVote, 1)))
      .all(),
    db.select({
        c: comments,
        userName: users.name,
        userEmail: users.email,
        userSubtitle: users.subtitle,
      })
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(and(eq(comments.billId, billId), isNull(comments.deletedAt)))
      .orderBy(comments.createdAt)
      .limit(20)
      .all(),
    db.select({ count: sql<number>`count(*)` })
      .from(comments)
      .where(and(eq(comments.billId, billId), isNull(comments.deletedAt)))
      .get(),
    db.select().from(billTexts).where(eq(billTexts.billId, billId)).orderBy(desc(billTexts.date)).all(),
    db.select({ setByName: users.name, createdAt: feedEvents.createdAt })
      .from(feedEvents)
      .innerJoin(users, eq(feedEvents.userId, users.id))
      .where(and(eq(feedEvents.billId, billId), eq(feedEvents.type, 'priority_set')))
      .orderBy(desc(feedEvents.createdAt))
      .limit(1)
      .get(),
  ])

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
        .where(and(inArray(commentReactions.commentId, commentIds), isNull(commentReactions.deletedAt)))
        .all()
    : []

  const reactionsByComment = new Map<string, Map<string, { count: number; userReacted: boolean; reactors: { name: string; subtitle: string | null }[] }>>()
  for (const { reaction: r, user: reactor } of reactionRows) {
    if (!reactionsByComment.has(r.commentId)) reactionsByComment.set(r.commentId, new Map())
    const emojiMap = reactionsByComment.get(r.commentId)!
    if (!emojiMap.has(r.emoji)) emojiMap.set(r.emoji, { count: 0, userReacted: false, reactors: [] })
    const entry = emojiMap.get(r.emoji)!
    entry.count++
    entry.reactors.push({ name: reactor.name, subtitle: reactor.subtitle })
    if (r.userId === currentUser.id) entry.userReacted = true
  }

  const formattedComments = commentRows.map(({ c: comment, userName, userEmail, userSubtitle }) => ({
    id: comment.id,
    userId: comment.userId,
    userName: userName || userEmail,
    userSubtitle: userSubtitle,
    content: comment.content,
    createdAt: comment.createdAt,
    reactions: Array.from(reactionsByComment.get(comment.id)?.entries() ?? []).map(
      ([emoji, data]) => ({ emoji, count: data.count, userReacted: data.userReacted, reactors: data.reactors }),
    ),
  }))

  let positionWithName: { position: string; setByName: string; updatedAt: string } | null = null
  if (positionRow) {
    const setter = await db.select({ name: users.name }).from(users).where(eq(users.id, positionRow.setBy)).get()
    positionWithName = {
      position: positionRow.position,
      setByName: setter?.name ?? 'Unknown',
      updatedAt: positionRow.updatedAt,
    }
  }

  // Resolve related bills using central SAST data when available; fall back to stored JSON
  type ResolvedRelated = { billId: number; billNumber: string; type: string; route: { id: string; billNumber: string; sessionSlug: string; state: string } | null }
  let resolvedRelated: ResolvedRelated[] = []
  if (centralRich?.relatedBills?.length) {
    const externalIds = centralRich.relatedBills
      .filter(r => r.sastBillId != null)
      .map(r => `legiscan:${r.sastBillId}`)
    const internalRows = externalIds.length > 0
      ? await db.select({ id: bills.id, externalId: bills.externalId, billNumber: bills.billNumber, session: bills.session, state: bills.state })
          .from(bills)
          .where(inArray(bills.externalId, externalIds))
          .all()
      : []
    const routeByExternal = new Map(internalRows.map(r => [r.externalId, { id: r.id, billNumber: r.billNumber, sessionSlug: sessionToSlug(r.session), state: r.state }]))
    resolvedRelated = centralRich.relatedBills.map(r => ({
      billId: r.sastBillId ?? 0,
      billNumber: r.identifier,
      type: r.relationType,
      route: r.sastBillId != null ? (routeByExternal.get(`legiscan:${r.sastBillId}`) ?? null) : null,
    }))
  } else {
    // Fallback: stored JSON may be an array of bill-number strings (legacy format)
    const stored = bill.relatedBillIds ? JSON.parse(bill.relatedBillIds) as unknown : []
    if (Array.isArray(stored)) {
      resolvedRelated = (stored as string[]).map(identifier => ({
        billId: 0,
        billNumber: String(identifier),
        type: 'related',
        route: null,
      }))
    }
  }

  const response: Record<string, unknown> = {
    id: bill.id,
    externalId: bill.externalId,
    billNumber: bill.billNumber,
    title: bill.title,
    state: bill.state,
    status: bill.status,
    session: bill.session,
    sessionSlug: sessionToSlug(bill.session),
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
    committee: bill.committee,
    tenantSummary: bill.tenantSummary,
    tags: JSON.parse(bill.tags) as string[],
    relevanceScore: bill.relevanceScore,
    priority: bill.priority,
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
    companionBillIds: bill.companionBillIds ? JSON.parse(bill.companionBillIds) : [],
    matchType: bill.matchType,
    newMatchAt: bill.newMatchAt ?? null,
    triageDismissedAt: bill.triageDismissedAt ?? null,
    isDraft: bill.isDraft,
    draftText: bill.draftText,
    textR2Key: bill.textR2Key,
    createdAt: bill.createdAt,
    updatedAt: bill.updatedAt,
    centralSyncedAt: bill.centralSyncedAt ?? null,
    aiProcessedAt: bill.aiProcessedAt ?? null,
    aiSkipReason: bill.aiSkipReason ?? null,
    lastAiTextDocId: bill.lastAiTextDocId,
    textStatus: bill.textStatus ?? null,
    myVote: myVoteRow?.position ?? null,
    myNote: myNoteRow?.content ?? null,
    position: positionWithName,
    voteCounts,
    comments: formattedComments,
    commentsTotal: commentCountRow?.count ?? 0,
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
    })) ?? undefined,
    subjects: centralRich?.subjects?.length ? centralRich.subjects : undefined,
    calendar: env.DEMO_MODE === 'true'
      ? await loadDemoBillCalendar(db, billId)
      : (centralRich?.calendar ?? []),
    amendments: centralRich?.amendments ?? [],
    supplements: centralRich?.supplements ?? [],
    customFieldValues: {} as Record<string, { value: string; setBy: string | null; updatedAt: string }>,
  }

  if (currentUser.role === 'admin' || currentUser.role === 'owner') {
    const memberVoteRows = await db
      .select({ userId: memberVotes.userId, userName: users.name, userEmail: users.email, position: memberVotes.position, votedAt: memberVotes.updatedAt })
      .from(memberVotes)
      .innerJoin(users, eq(memberVotes.userId, users.id))
      .where(eq(memberVotes.billId, billId))
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

  // Custom field values
  const cfRows = await db
    .select({
      fieldId: billCustomFieldValues.fieldId,
      value: billCustomFieldValues.value,
      setBy: users.name,
      updatedAt: billCustomFieldValues.updatedAt,
    })
    .from(billCustomFieldValues)
    .innerJoin(users, eq(billCustomFieldValues.setBy, users.id))
    .where(eq(billCustomFieldValues.billId, billId))
    .all()

  response.customFieldValues = Object.fromEntries(
    cfRows.map((r) => [r.fieldId, { value: r.value, setBy: r.setBy, updatedAt: r.updatedAt }])
  )

  return response
}
