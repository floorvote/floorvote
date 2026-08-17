import { Hono } from 'hono'
import { getDb } from '../db/client'
import {
  users, bills, billTexts,
  memberVotes, officialPositions, comments, commentReactions, notes,
  feedEvents, publicReports, associationConfig,
  customFieldDefinitions, billCustomFieldValues,
  calendarEvents, calendarEventBills,
} from '../db/schema'
import { gt, and, inArray, sql, type SQL } from 'drizzle-orm'
import { centralFetch } from '../lib/centralFetch'
import { EXPORT_TABLES, type ExportTable } from '../../../shared/exportTables'
import type { AppEnv } from '../types'

const tableMap = {
  users,
  bills,
  billTexts,
  memberVotes,
  officialPositions,
  comments,
  commentReactions,
  notes,
  feedEvents,
  publicReports,
  associationConfig,
  customFieldDefinitions,
  billCustomFieldValues,
  calendarEvents,
  calendarEventBills,
} as const

// Compile-time guarantee that the route's tableMap covers exactly the shared
// export list — keeps frontend and backend from drifting (the cause of the
// "Unknown table name" bug). A backend test also asserts this at runtime.
const _exhaustive: Record<ExportTable, unknown> = tableMap
void _exhaustive

type TableName = keyof typeof tableMap

const SAFE_USER_COLUMNS = ['id', 'email', 'name', 'role', 'subtitle', 'invitedBy', 'createdAt', 'lastActive', 'deactivatedAt', 'canVote'] as const

// A tenant's `bills` table is dominated by lightweight "monitoring" stubs —
// bills outside the keyword set the tenant doesn't actually track (on a large
// multi-state tenant this is ~97% of rows). The export only includes
// "meaningful" bills: anything the tenant tracks, has analyzed, has prioritized,
// or has engaged with. (match_type alone is insufficient — a bill can be
// demoted to a null match_type by a keyword resync yet keep its AI summary or
// engagement.) Applied to the `bills` and `billTexts` dumps and the /rich path.
const MEANINGFUL_BILLS = sql`(
  ${bills.matchType} IS NOT NULL
  OR ${bills.aiProcessedAt} IS NOT NULL
  OR ${bills.priority} IS NOT NULL
  OR ${bills.id} IN (
    SELECT bill_id FROM member_votes
    UNION SELECT bill_id FROM official_positions
    UNION SELECT bill_id FROM comments
    UNION SELECT bill_id FROM notes
  )
)`

// association_config is a key/value grab-bag that also holds internal caches
// (sessions), operational counters (resend_*, last_digest_at), a secret feed
// token (calendar_feed_slug), and dead keys. The export emits only meaningful,
// user-facing config — a whitelist so any future internal key is excluded by
// default rather than silently leaking.
const EXPORT_CONFIG_KEYS = [
  'association_name', 'ai_context', 'keywords',
  'org_noun', 'position_label', 'position_vocabulary',
  'relevance_question', 'tag_taxonomy',
  'modules', 'sync_frequency',
  'mention_emails_enabled', 'state_coverage',
] as const

// Per-table base filter applied in addition to cursor pagination. Only the
// bill-bearing tables and association_config are scoped; engagement/feed/custom-
// field tables only ever reference meaningful bills, so they're dumped whole.
function baseFilter(tableName: TableName): SQL | undefined {
  if (tableName === 'bills') return MEANINGFUL_BILLS
  if (tableName === 'billTexts') return sql`${billTexts.billId} IN (SELECT id FROM bills WHERE ${MEANINGFUL_BILLS})`
  if (tableName === 'associationConfig') return inArray(associationConfig.key, [...EXPORT_CONFIG_KEYS])
  return undefined
}

// Separator for the composite-key cursor below. A null byte (char 0) sorts below
// every other character, so lexicographic order of `event_id || SEP || bill_id`
// matches (event_id, bill_id) tuple order. The ORDER BY expression (SQL char(0))
// and the cursor value must use the identical separator so the next page's `gt`
// comparison lines up.
const COMPOSITE_SEP = String.fromCharCode(0)

// Composite-PK tables have no single unique `id` column, so they order and
// cursor on a null-byte-joined tuple of their two key columns.
const COMPOSITE_KEYS: Partial<Record<TableName, [any, any, (row: any) => string]>> = {
  calendarEventBills: [calendarEventBills.eventId, calendarEventBills.billId, (r) => `${r.eventId}${COMPOSITE_SEP}${r.billId}`],
  billCustomFieldValues: [billCustomFieldValues.billId, billCustomFieldValues.fieldId, (r) => `${r.billId}${COMPOSITE_SEP}${r.fieldId}`],
}

// Each export table is paginated with a cursor over a stable, ordered key.
// Most tables key on `id`; associationConfig keys on `key`; composite-PK tables
// use the COMPOSITE_KEYS tuple expression above.
function getCursorSpec(tableName: TableName): { orderBy: SQL | any; cursorOf: (row: any) => string } {
  if (tableName === 'associationConfig') {
    return { orderBy: associationConfig.key, cursorOf: (r) => r.key }
  }
  const composite = COMPOSITE_KEYS[tableName]
  if (composite) {
    const [colA, colB, cursorOf] = composite
    return { orderBy: sql`${colA} || char(0) || ${colB}`, cursorOf }
  }
  return { orderBy: (tableMap[tableName] as any).id, cursorOf: (r) => r.id }
}

export const exportApiRouter = new Hono<AppEnv>()

// LegiScan rich data (amendments, supplements, roll-call votes) is not stored in
// the tenant DB — it lives on central. This endpoint cursor-paginates over the
// tenant's meaningful LegiScan bills and, for each page, makes a single bulk
// call to central's /bills/rich-batch (a handful of indexed `IN (...)` queries)
// rather than one full-detail call per bill. Returns flattened rows tagged with
// the tenant billId/billNumber so they join back to the bills export. No
// LegiScan API quota is consumed (central reads its own DB).
// NOTE: must be registered before the `/:table` route so it isn't swallowed.
exportApiRouter.get('/rich', async (c) => {
  const db = getDb(c.env.DB)

  const cursor = c.req.query('cursor')
  const limitParam = c.req.query('limit')
  let limit = limitParam ? parseInt(limitParam, 10) : 200
  if (isNaN(limit) || limit < 1) limit = 200
  if (limit > 500) limit = 500

  // Only meaningful bills carry useful rich data and are actually viewed;
  // restricting here avoids pulling rich data for lightweight stubs.
  const where = cursor
    ? sql`${bills.externalId} LIKE 'legiscan:%' AND ${MEANINGFUL_BILLS} AND ${bills.id} > ${cursor}`
    : sql`${bills.externalId} LIKE 'legiscan:%' AND ${MEANINGFUL_BILLS}`

  let billRows = await db
    .select({ id: bills.id, externalId: bills.externalId, billNumber: bills.billNumber })
    .from(bills)
    .where(where)
    .orderBy(bills.id)
    .limit(limit + 1)

  let nextCursor: string | null = null
  if (billRows.length > limit) {
    billRows = billRows.slice(0, limit)
    nextCursor = billRows[billRows.length - 1].id
  }

  const amendments: Record<string, unknown>[] = []
  const supplements: Record<string, unknown>[] = []
  const votes: Record<string, unknown>[] = []

  type Rich = { amendments?: any[]; supplements?: any[]; votes?: any[] }
  let byId: Record<string, Rich> = {}
  const ids = billRows.map(b => b.externalId).filter((id): id is string => !!id)
  if (ids.length > 0) {
    try {
      const res = await centralFetch(c.env, '/bills/rich-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (res.ok) byId = ((await res.json()) as { byId?: Record<string, Rich> }).byId ?? {}
    } catch {
      // Non-fatal — if central is unreachable the page contributes no rich rows.
    }
  }

  for (const b of billRows) {
    const rich = b.externalId ? byId[b.externalId.replace('legiscan:', '')] : undefined
    if (!rich) continue
    for (const a of rich.amendments ?? []) {
      amendments.push({ billId: b.id, billNumber: b.billNumber, ...a })
    }
    for (const s of rich.supplements ?? []) {
      supplements.push({ billId: b.id, billNumber: b.billNumber, ...s })
    }
    for (const v of rich.votes ?? []) {
      const counts: Array<{ option: string; value: number }> = v.counts ?? []
      const count = (opt: string) => counts.find((x) => x.option === opt)?.value ?? 0
      votes.push({
        billId: b.id,
        billNumber: b.billNumber,
        voteId: v.id,
        date: v.date,
        chamber: v.chamber,
        motionText: v.motionText,
        result: v.result,
        yes: count('yes'),
        no: count('no'),
        notVoting: count('not voting'),
        absent: count('absent'),
      })
    }
  }

  return c.json({ amendments, supplements, votes, nextCursor })
})

exportApiRouter.get('/:table', async (c) => {
  const tableName = c.req.param('table') as string

  if (!(tableName in tableMap)) {
    return c.json({ error: 'Unknown table name' }, 400)
  }

  const name = tableName as TableName
  const table = tableMap[name]
  const { orderBy, cursorOf } = getCursorSpec(name)

  const cursor = c.req.query('cursor')
  const limitParam = c.req.query('limit')
  let limit = limitParam ? parseInt(limitParam, 10) : 500
  if (isNaN(limit) || limit < 1) limit = 500
  if (limit > 1000) limit = 1000

  const db = getDb(c.env.DB)

  const conditions: SQL[] = []
  const base = baseFilter(name)
  if (base) conditions.push(base)
  if (cursor) conditions.push(gt(orderBy, cursor))
  const whereClause = conditions.length ? and(...conditions) : undefined

  let rows = await (whereClause
    ? db.select().from(table).where(whereClause).orderBy(orderBy).limit(limit + 1)
    : db.select().from(table).orderBy(orderBy).limit(limit + 1))

  let nextCursor: string | null = null
  if (rows.length > limit) {
    rows = rows.slice(0, limit)
    nextCursor = cursorOf(rows[rows.length - 1] as any)
  }

  // Filter sensitive columns for users table
  if (name === 'users') {
    rows = rows.map((row: any) => {
      const filtered: Record<string, unknown> = {}
      for (const col of SAFE_USER_COLUMNS) {
        filtered[col] = row[col]
      }
      return filtered
    }) as any
  }

  return c.json({ table: name, rows, nextCursor })
})

// Re-exported for tests asserting the route covers the shared export list.
export { EXPORT_TABLES }
