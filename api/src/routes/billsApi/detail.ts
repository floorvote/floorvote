import { eq, and, or, inArray, sql, desc, isNull } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { rowidOf } from '../../db/rowid'
import {
  bills, comments, users, commentReactions, feedEvents,
  billTexts, roles, userRoles, teamEvents, billMutes,
} from '../../db/schema'
import type { Env } from '../../types'
import { centralFetch } from '../../lib/centralFetch'
import { chunkedForms, isHandle, legacyHandle, normalizeHandle, toHandle } from '../../../../shared/billHandle'
import { httpUrl } from '../../../../shared/httpUrl'
import { isRelationshipKind, type RelationshipKind } from '../../../../shared/relationshipKinds'
import type { BillExtras } from '../../../../shared/providerExtras'
import { dbTsToEpoch } from '../../../../shared/time'
import { billSlug, filedSlug } from '../../lib/sessionSlug'
import { loadDemoBillCalendar } from '../../lib/demoCalendar'
import { activeUser } from '../../lib/accountDeletion'
import { loadCommentAttachments } from '../../lib/attachments'
import { loadTaxonomyTagNameSet, filterTagsToTaxonomy } from '../../lib/taxonomy'
import { parseSubjects, loadSuppressedSubjectStates, isSubjectsSuppressedForState } from '../../lib/billSubjects'
import { displayName, userDisplayNameSql } from '../../lib/displayName'
import { titleOf, userTitleSql } from '../../lib/userTitle'
import { groupMemberIds, groupVotes, inGroupOf, loadGroupBills, loadGroupNotes, mergeGroupNotes } from '../../lib/companionGroups'
import { loadFieldDefs, loadGroupTeamValues } from '../../lib/teamFields'
import { isReplyParticipant } from '../../lib/replies'
import { findCompanionSuggestion } from '../../lib/companionSuggestion'
import { claimLinksEnabled, readClaimSources } from '../../lib/claimSources'
import type { GroupBillTexts, GroupingEvent, GroupingEventMetadata, GroupingEventType } from '../../../../shared/companionGroups'
import { FIELD_CHANGED, type FieldChangedMetadata, type FieldChangeEvent, type TeamField } from '../../../../shared/teamFields'

type CentralBillRich = {
  billType?: string | null
  body?: string | null
  /** What title-matched companion suggestions match the bill by, or null (#521). */
  titleKey?: string | null
  statusDate?: string | null
  legiscanUrl?: string | null
  sponsors?: Array<{ name: string; party: string | null; role: string | null; primary: boolean; personId: string | null; url: string | null }>
  votes?: Array<{ id: string; motionText: string; date: string; result: string; chamber: string; counts: Array<{ option: string; value: number }>; legislatorVotes?: Array<{ personId: string; name: string; vote: string; url?: string | null; party?: string | null }> }>
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

/**
 * The field changes a bill page's comment thread shows lines for, oldest first, from the `field_changed`
 * team events of the bill's group. The thread shows only changes people made, so an event with no actor
 * is left out, and so is a tags change, which the AI analysis once recorded (with no actor) and no longer
 * does: older rows stay in `team_events`. An event whose metadata can't be read is skipped rather than
 * failing the page. A bulk edit that selected two bills of a group wrote the same change on each, which the group
 * made once, so a change identical to one already read (same time, actor, field, and values) is dropped,
 * keeping the one made on this bill. Timestamps come in two shapes (see dbTsToEpoch), so the order is
 * settled here, on top of the read's order, which breaks a tie by the order the events were written.
 */
// The fields a person sets, which the thread has lines for. A row for any other (the analysis's tags) is skipped.
const RECORDED_FIELDS: ReadonlySet<string> = new Set<TeamField>(['position', 'priority', 'customField'])

function readFieldEvents(
  rows: ReadonlyArray<{ id: string; billId: string; actorId: string | null; actorName: string | null; createdAt: string; metadata: string }>,
  billId: string,
  billNumberOf: ReadonlyMap<string, string>,
  defs: ReadonlyArray<{ id: string; type: string }>,
): FieldChangeEvent[] {
  const typeOf = new Map(defs.map(d => [d.id, d.type]))
  const read: FieldChangeEvent[] = []
  const seen = new Map<string, number>()
  for (const row of [...rows].sort((a, b) => dbTsToEpoch(a.createdAt) - dbTsToEpoch(b.createdAt))) {
    if (row.actorId === null || row.actorName === null) continue
    let meta: FieldChangedMetadata
    try { meta = JSON.parse(row.metadata) as FieldChangedMetadata } catch { continue }
    if (!meta || typeof meta !== 'object' || typeof meta.field !== 'string') continue
    if (!RECORDED_FIELDS.has(meta.field)) continue
    const event: FieldChangeEvent = {
      id: row.id,
      createdAt: row.createdAt,
      actorId: row.actorId,
      actorName: row.actorName,
      billId: row.billId,
      billNumber: billNumberOf.get(row.billId) ?? '',
      field: meta.field,
      ...(meta.fieldId !== undefined ? { fieldId: meta.fieldId } : {}),
      label: meta.label,
      old: meta.old ?? null,
      new: meta.new ?? null,
      ...(meta.fieldId !== undefined && typeOf.has(meta.fieldId) ? { fieldType: typeOf.get(meta.fieldId) } : {}),
    }
    const key = [dbTsToEpoch(row.createdAt), row.actorId, event.field, event.fieldId, JSON.stringify(event.old), JSON.stringify(event.new)].join('|')
    const at = seen.get(key)
    if (at === undefined) {
      seen.set(key, read.length)
      read.push(event)
    } else if (row.billId === billId && read[at].billId !== billId) {
      read[at] = event
    }
  }
  return read
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
  // No AI here. `view` tells central this is a page view: when the bill is a
  // stub whose detail is stale, central refreshes it in the background
  // (central/src/lib/stubRefresh.ts), and this read doesn't wait for it. A demo
  // sends no flag, since its anonymous visitors would spend the provider budget.
  let centralRich: CentralBillRich | null = null
  if (isHandle(bill.externalId)) {
    try {
      const res = await centralFetch(env, `/bills/${legacyHandle(bill.externalId)}${env.DEMO_MODE === 'true' ? '' : '?view=1'}`)
      if (res.ok) centralRich = await res.json() as CentralBillRich
    } catch {
      // Non-fatal — bill detail still works without the supplemental data
    }
  }

  // A bill's companion group shares its conversation, votes, and notes, and
  // each read below resolves across the group (lib/companionGroups.ts). For an
  // ungrouped bill the group is the bill alone.
  const votes = groupVotes(db, billId)
  const [groupBills, myVoteRow, myNotes, myMuteRow, isParticipant, teamValues, voteRows, commentRows, commentCountRow, textRows, priorityEventRow, threadEventRows, fieldDefs] = await Promise.all([
    loadGroupBills(db, billId),
    db.select({ position: votes.position }).from(votes).where(eq(votes.userId, currentUser.id)).get(),
    loadGroupNotes(db, billId, currentUser.id),
    // Muting any bill in the group mutes its one conversation.
    db.select({ userId: billMutes.userId }).from(billMutes)
      .where(and(inGroupOf(billMutes.billId, billId), eq(billMutes.userId, currentUser.id)))
      .get(),
    isReplyParticipant(db, currentUser.id, billId),
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
    // The team events its comment thread shows lines for, in one ordered read. Its own grouping events
    // say where its group formed or split (a companion's are about the companion). The field changes are
    // the group's, made on any member: a value is shared, so a change to it is one the whole group made.
    // A deactivated member's are hidden, as their comments are (activeUser). Only changes people made reach the
    // thread (readFieldEvents leaves out one with no actor).
    db.select({ id: teamEvents.id, type: teamEvents.type, billId: teamEvents.billId, actorId: teamEvents.actorUserId, createdAt: teamEvents.createdAt, metadata: teamEvents.metadata, actorName: userDisplayNameSql })
      .from(teamEvents)
      .leftJoin(users, eq(teamEvents.actorUserId, users.id))
      .where(or(
        and(eq(teamEvents.billId, billId), inArray(teamEvents.type, ['grouped', 'split'] satisfies GroupingEventType[])),
        and(inGroupOf(teamEvents.billId, billId), eq(teamEvents.type, FIELD_CHANGED), activeUser),
      ))
      .orderBy(teamEvents.createdAt, rowidOf(teamEvents))
      .all(),
    // A custom field's type words a yes/no value in a sentence about it.
    loadFieldDefs(db),
  ])
  const billNumberOf = new Map(groupBills.map(b => [b.billId, b.billNumber]))
  const groupingRows = threadEventRows.filter(e => e.type !== FIELD_CHANGED)
  // The text versions of every bill in the group, newest first, for the page's
  // Bill texts to list under each bill's badge (#712). A bill with none is left out.
  const groupTextRows = await db.select().from(billTexts)
    .where(inArray(billTexts.billId, groupBills.map(b => b.billId)))
    .orderBy(desc(billTexts.date), desc(billTexts.docId)).all()
  const groupTexts: GroupBillTexts[] = groupBills.flatMap(g => {
    const texts = groupTextRows.filter(t => t.billId === g.billId).map(t => ({
      docId: t.docId, type: t.type, date: t.date, mime: t.mime, stateLink: t.stateLink, altStateLink: t.altStateLink,
    }))
    return texts.length > 0 ? [{ ...g, texts }] : []
  })
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

  const fieldEvents = readFieldEvents(threadEventRows.filter(e => e.type === FIELD_CHANGED), billId, billNumberOf, fieldDefs)

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
  const attachmentsByComment = await loadCommentAttachments(db, commentIds)

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
    attachments: attachmentsByComment.get(comment.id) ?? [],
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
    const internalRows = []
    for (const part of chunkedForms(externalIds)) {
      internalRows.push(...await db.select({ id: bills.id, externalId: bills.externalId, billNumber: bills.billNumber, session: bills.session, sessionSlug: bills.sessionSlug, state: bills.state })
        .from(bills)
        .where(inArray(bills.externalId, part))
        .all())
    }
    const routeByExternal = new Map(internalRows.map(r => [normalizeHandle(r.externalId), { id: r.id, billNumber: r.billNumber, sessionSlug: filedSlug(r) ?? '', state: r.state }]))
    resolvedRelated = centralRich.relatedBills.map(r => ({
      billId: r.sastBillId ?? 0,
      billNumber: r.identifier,
      type: r.relationType,
      // A central that predates kinds sends none, and a bill is then only related.
      kind: isRelationshipKind(r.kind) ? r.kind : 'related',
      route: r.sastBillId != null ? (routeByExternal.get(normalizeHandle(toHandle(r.sastBillId))) ?? null) : null,
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
  // shows another member's, its lead's (lib/groupLead.ts), or while the lead
  // has none, a tracked member's (#554). Regenerate re-analyzes it and polls its
  // analysis time (#563), so the page needs its handle and where its analysis
  // stands, which on a companion's page are not the page bill's own.
  const analysisBillId = teamValues.analysis?.billId ?? bill.id
  const analysisBill = analysisBillId === bill.id
    ? bill
    : (await db.select({
        id: bills.id, externalId: bills.externalId, billNumber: bills.billNumber,
        aiProcessedAt: bills.aiProcessedAt, aiSkipReason: bills.aiSkipReason, textStatus: bills.textStatus,
        lastAiTextDocId: bills.lastAiTextDocId,
      }).from(bills).where(eq(bills.id, analysisBillId)).get()) ?? bill

  // The bill Regenerate analyzes when it isn't the one above: the group's lead,
  // while it has no analysis and the page shows another member's. Regenerate
  // analyzes it, and the page polls until its analysis is the one shown.
  const leadId = teamValues.leadBillId
  const regenerateBill = leadId !== null && leadId !== analysisBill.id
    ? (await db.select({
        id: bills.id, externalId: bills.externalId, billNumber: bills.billNumber,
        aiProcessedAt: bills.aiProcessedAt, aiSkipReason: bills.aiSkipReason, textStatus: bills.textStatus,
      }).from(bills).where(eq(bills.id, leadId)).get()) ?? null
    : null

  // The document that analysis read, as the text list has it, for the page to
  // name and open (#601). On a companion's page it is the analyzed member's,
  // which is not in this bill's list. Null when none is recorded or it is no
  // longer listed.
  const analysisDocId = analysisBill.lastAiTextDocId ?? null
  const analysisLastAiText = analysisDocId === null ? null : (await db.select({
    docId: billTexts.docId, type: billTexts.type, date: billTexts.date, mime: billTexts.mime,
    stateLink: billTexts.stateLink, altStateLink: billTexts.altStateLink,
  }).from(billTexts)
    .where(and(eq(billTexts.billId, analysisBill.id), eq(billTexts.docId, analysisDocId))).get()) ?? null

  const linksOn = await claimLinksEnabled(db)
  const stored = linksOn ? await readClaimSources(db, analysisBill.id) : null
  const claimSourcesForPage = stored && {
    billId: stored.billId,
    document: stored.document,
    items: stored.items.map(i => ({
      claim: i.claim,
      status: i.status,
      ...(i.quoteAt && i.matched !== undefined ? { quoteAt: i.quoteAt, matched: i.matched } : {}),
      // A PDF's item links by page, with its quote shown beside the link (#572).
      // The instance never matched the quote, so these are the model's own.
      ...(i.status === 'unverified' ? { quote: i.quote, page: typeof i.page === 'number' ? i.page : null } : {}),
      // An anchored item's matched text is only an anchor, so the page shows the model's whole quote (#802).
      ...(i.status === 'anchored' ? { quote: i.quote } : {}),
    })),
  }

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
    // The group's analysis: its lead's, or while the lead has none, the most recently analyzed tracked member's (any member's when none tracked has one).
    tenantSummary: teamValues.analysis ? teamValues.analysis.tenantSummary : bill.tenantSummary,
    tags: filterTagsToTaxonomy(teamValues.analysis ? teamValues.analysis.tags : JSON.parse(bill.tags) as string[], tagSet),
    relevanceScore: bill.relevanceScore,
    priority: teamValues.priority?.priority ?? null,
    priorityMeta: priorityEventRow ? { setByName: priorityEventRow.setByName, updatedAt: priorityEventRow.createdAt } : null,
    sponsor: bill.sponsor,
    sponsorParty: bill.sponsorParty,
    sponsorUrl: httpUrl(centralRich?.sponsors?.find(s => s.primary)?.url ?? bill.sponsorUrl),
    coSponsors: centralRich?.sponsors
      ? (() => {
          // The primary sponsor shown in bill.sponsor is the first primary-flagged sponsor.
          // All others (including additional primary-flagged sponsors like co-primary sponsors
          // in NJ-style multi-primary bills) go into coSponsors, with primary:true preserved
          // so the UI can distinguish them from regular co-sponsors.
          const primaryName = bill.sponsor
          return centralRich.sponsors
            .filter(s => s.name !== primaryName)
            .map(s => ({ name: s.name, url: httpUrl(s.url), party: s.party ?? null, primary: s.primary ?? false }))
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
    // group or on the page of the bill whose analysis the group shows, that
    // bill's on another member's.
    analysisBillId: analysisBill.id,
    analysisBillExternalId: analysisBill.externalId ?? null,
    analysisBillNumber: analysisBill.billNumber,
    analysisAiProcessedAt: analysisBill.aiProcessedAt ?? null,
    analysisAiSkipReason: analysisBill.aiSkipReason ?? null,
    analysisTextStatus: analysisBill.textStatus ?? null,
    // The lead, when Regenerate should analyze it instead of the bill above. Null otherwise.
    regenerateBill: regenerateBill && {
      id: regenerateBill.id,
      externalId: regenerateBill.externalId ?? null,
      billNumber: regenerateBill.billNumber,
      aiProcessedAt: regenerateBill.aiProcessedAt ?? null,
      aiSkipReason: regenerateBill.aiSkipReason ?? null,
      textStatus: regenerateBill.textStatus ?? null,
    },
    // The document that analysis read (#601): the link above the summary names and opens it.
    analysisLastAiTextDocId: analysisDocId,
    analysisLastAiText,
    // Whether the instance shows claim links (#570). Off, a bill's stored claim
    // links render as plain text (#571, #572). It's the instance's setting, the
    // same for every bill, and the stored links are untouched either way.
    claimLinksEnabled: linksOn,
    // The shown analysis's claim sources, for the page to link each claim to
    // its passage (#571). Read through the analysis's bill, so on a companion's
    // page they are the analyzed member's, pinned to that member's document,
    // never the page bill's own text. Null with the setting off, with none
    // stored, or when the pinned document is no longer in the analyzed bill's
    // texts. An item is only what a link needs.
    claimSources: claimSourcesForPage,
    textStatus: bill.textStatus ?? null,
    myVote: myVoteRow?.position ?? null,
    // The member's notes across the group, and the one note they edit, which
    // holds them all under their bill numbers until the next save merges them.
    myNote: mergeGroupNotes(myNotes),
    myNotes,
    commentsMuted: !!myMuteRow,
    // Whether the member would get reply notifications here (they commented on
    // the bill or its group), decided by the rule the reply emails use. The page
    // offers Mute only to a participant, and Unmute to anyone muted.
    commentsParticipant: isParticipant,
    position: positionWithName,
    voteCounts,
    comments: formattedComments,
    commentsTotal: commentCountRow?.count ?? 0,
    groupingEvents,
    fieldEvents,
    // The bills in its companion group, this one first: just this one in no group.
    groupBills,
    // Every group bill's versions, one entry per bill with any (#712). The page bill's own are `texts`.
    groupTexts,
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
      // Each voter's profile link as central sent it, if it is an http(s) URL.
      legislatorVotes: (v.legislatorVotes ?? []).map(l => ({ ...l, url: httpUrl(typeof l.url === 'string' ? l.url : null), party: typeof l.party === 'string' && l.party.trim() ? l.party.trim() : null })),
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

    // Another bill with the same title, one admins can group this one with
    // (#521). Not on a demo, where grouping by hand is denied.
    response.companionSuggestion = env.DEMO_MODE === 'true' || bill.isDraft
      ? null
      : await findCompanionSuggestion(db, bill, centralRich)
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
