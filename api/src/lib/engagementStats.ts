import { sql, isNotNull, isNull, and, gt, ne, or, like, notInArray } from 'drizzle-orm'
import type { getDb } from '../db/client'
import * as schema from '../db/schema'

type DB = ReturnType<typeof getDb>

export interface EngagementStats {
  total_members: number
  active_members_7d: number
  active_members_30d: number
  votes_cast: number
  comments_written: number
  comment_reactions: number
  positions_set: number
  notes_created: number
  custom_field_values: number
  bills_with_engagement: number
  roles_defined: number
  custom_fields_defined: number
  bills_ai_processed: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function computeEngagementStats(db: DB): Promise<EngagementStats> {
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS).toISOString()

  const [
    totalMembersRow,
    active7Row,
    active30Row,
    votesRow,
    commentsRow,
    reactionsRow,
    positionsRow,
    notesRow,
    customValuesRow,
    engagedBillsRow,
    rolesRow,
    customDefsRow,
    aiProcessedRow,
  ] = await Promise.all([
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.users).get(),
    db.select({ n: sql<number>`COUNT(DISTINCT ${schema.sessions.userId})` })
      .from(schema.sessions)
      .where(gt(schema.sessions.lastActive, sevenDaysAgo))
      .get(),
    db.select({ n: sql<number>`COUNT(DISTINCT ${schema.sessions.userId})` })
      .from(schema.sessions)
      .where(gt(schema.sessions.lastActive, thirtyDaysAgo))
      .get(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.memberVotes).get(),
    db.select({ n: sql<number>`COUNT(*)` })
      .from(schema.comments)
      .where(isNull(schema.comments.deletedAt))
      .get(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.commentReactions).get(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.officialPositions).get(),
    db.select({ n: sql<number>`COUNT(*)` })
      .from(schema.notes)
      .where(ne(schema.notes.content, ''))
      .get(),
    db.select({ n: sql<number>`COUNT(*)` })
      .from(schema.billCustomFieldValues)
      .where(and(isNotNull(schema.billCustomFieldValues.value), ne(schema.billCustomFieldValues.value, '')))
      .get(),
    db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM (
      SELECT bill_id FROM member_votes
      UNION
      SELECT bill_id FROM comments WHERE deleted_at IS NULL
      UNION
      SELECT bill_id FROM official_positions
    )`),
    db.select({ n: sql<number>`COUNT(*)` })
      .from(schema.roles)
      .where(isNull(schema.roles.deletedAt))
      .get(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.customFieldDefinitions).get(),
    db.select({ n: sql<number>`COUNT(*)` })
      .from(schema.bills)
      .where(isNotNull(schema.bills.aiProcessedAt))
      .get(),
  ])

  return {
    total_members: Number(totalMembersRow?.n ?? 0),
    active_members_7d: Number(active7Row?.n ?? 0),
    active_members_30d: Number(active30Row?.n ?? 0),
    votes_cast: Number(votesRow?.n ?? 0),
    comments_written: Number(commentsRow?.n ?? 0),
    comment_reactions: Number(reactionsRow?.n ?? 0),
    positions_set: Number(positionsRow?.n ?? 0),
    notes_created: Number(notesRow?.n ?? 0),
    custom_field_values: Number(customValuesRow?.n ?? 0),
    bills_with_engagement: Number(engagedBillsRow?.n ?? 0),
    roles_defined: Number(rolesRow?.n ?? 0),
    custom_fields_defined: Number(customDefsRow?.n ?? 0),
    bills_ai_processed: Number(aiProcessedRow?.n ?? 0),
  }
}

/** The subset of metrics that are attributable to an individual member and thus
 *  meaningfully "excludable" by that member's email domain. */
export interface ExcludedEngagementStats {
  total_members: number
  active_members_7d: number
  active_members_30d: number
  votes_cast: number
  comments_written: number
  comment_reactions: number
}

/**
 * Normalize a raw exclusion-domain list: lowercased, trimmed, stripped to
 * domain-safe characters (also neutralizes SQL LIKE wildcards), de-duplicated,
 * and requiring at least one dot so a stray token can't match everything.
 */
export function normalizeExcludeDomains(domains: string[] | undefined | null): string[] {
  if (!domains) return []
  const cleaned = domains
    .map(d => d.trim().toLowerCase().replace(/[^a-z0-9.-]/g, ''))
    .filter(d => d.length > 0 && d.includes('.'))
  return [...new Set(cleaned)]
}

/**
 * Recompute the user-attributable metrics with members whose email is on an
 * excluded domain removed. A domain `d` excludes both `*@d` (exact) and `*.d`
 * (subdomains). Returns null when no valid domains are given, signalling "no
 * variant to store" to the caller. Row-level filters use a `NOT IN (subquery)`
 * so a large exclusion set can't blow D1's bound-parameter limit.
 */
export async function computeExcludedEngagementStats(
  db: DB,
  rawDomains: string[] | undefined | null,
): Promise<ExcludedEngagementStats | null> {
  const domains = normalizeExcludeDomains(rawDomains)
  if (domains.length === 0) return null

  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS).toISOString()

  // Users whose email matches any excluded domain (exact @domain or a subdomain).
  const emailMatchesExcluded = or(
    ...domains.flatMap(d => [
      like(schema.users.email, `%@${d}`),
      like(schema.users.email, `%.${d}`),
    ]),
  )
  const excludedUserIds = db.select({ id: schema.users.id }).from(schema.users).where(emailMatchesExcluded)

  const [members, active7, active30, votes, comments, reactions] = await Promise.all([
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.users)
      .where(notInArray(schema.users.id, excludedUserIds)).get(),
    db.select({ n: sql<number>`COUNT(DISTINCT ${schema.sessions.userId})` }).from(schema.sessions)
      .where(and(gt(schema.sessions.lastActive, sevenDaysAgo), notInArray(schema.sessions.userId, excludedUserIds))).get(),
    db.select({ n: sql<number>`COUNT(DISTINCT ${schema.sessions.userId})` }).from(schema.sessions)
      .where(and(gt(schema.sessions.lastActive, thirtyDaysAgo), notInArray(schema.sessions.userId, excludedUserIds))).get(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.memberVotes)
      .where(notInArray(schema.memberVotes.userId, excludedUserIds)).get(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.comments)
      .where(and(isNull(schema.comments.deletedAt), notInArray(schema.comments.userId, excludedUserIds))).get(),
    db.select({ n: sql<number>`COUNT(*)` }).from(schema.commentReactions)
      .where(notInArray(schema.commentReactions.userId, excludedUserIds)).get(),
  ])

  return {
    total_members: Number(members?.n ?? 0),
    active_members_7d: Number(active7?.n ?? 0),
    active_members_30d: Number(active30?.n ?? 0),
    votes_cast: Number(votes?.n ?? 0),
    comments_written: Number(comments?.n ?? 0),
    comment_reactions: Number(reactions?.n ?? 0),
  }
}
