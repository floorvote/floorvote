import { sql, isNotNull, isNull, and, gt, ne } from 'drizzle-orm'
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
