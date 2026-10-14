import { sql, type SQL } from 'drizzle-orm'
import { bills, billCustomFieldValues, comments, memberVotes, notes, officialPositions, users } from '../../db/schema'
import { activeUser } from '../../lib/accountDeletion'
import { rowidOf } from '../../db/rowid'
import { resolveTeamValues, type GroupTeamValues } from '../../lib/teamFields'
import { billSlug } from '../../lib/sessionSlug'
import { filterTagsToTaxonomy } from '../../lib/taxonomy'
import type { AppDb } from '../../types'
import { billsAs, buildBillNumberBoost, newMatchWhere, type BillsFilter } from './query'

/**
 * The bill list's companion groups (see **Companion group** in CONTEXT.md).
 *
 * The list shows one row per group, in pages of groups. A filter matches a group
 * through any bill in it, and the filter's predicates stay per bill: this
 * module only asks "does some bill in the group meet it" and never changes
 * what meeting it means (query.ts). Everything is written to stay on the
 * indexes the list used before groups:
 *
 * - A bill with no companions is its own group, and a group is named by its
 *   group key, the smallest id in it. `COALESCE(group_key, id)` names every
 *   group, and `idx_bills_group_key` finds the bills of one.
 * - Counting reads the bills that meet the filter as before, then corrects
 *   for groups from indexes that carry the group key (`countGroups`).
 * - The ordered page selects the groups, with each sort key computed from
 *   the group (below), then reads the bills of just the groups on the page
 *   (`loadGroupRows`).
 */

const c = billsAs('c') // the bill that stands for its group in a page query
const m = billsAs('m') // a bill the filter tests

// ── Counting ────────────────────────────────────────────────────────────────

const andFilter = (filter: SQL | undefined) => (filter ? sql` AND ${filter}` : sql``)

/**
 * How many groups have a bill meeting the filter: the bills that meet it, as
 * before groups, less the extra bills of each group among them. The grouped
 * bills that meet it are read through the group key index, which carries the
 * columns the common filters read (status, stage, state, session, year, and
 * relevance), so those filters count the grouped bills from that one small
 * index without reading the table. Each statement holds the filter once, so
 * binds a filter's values once. The exception is a team field's filter
 * (priority, position, custom field), which binds its values twice, once for
 * the bill holding the group's value and once for the rest of the group.
 *
 * `selective` says the filter picks few bills from an index of its own (new
 * matches, my bills, drafts), so the grouped ones are found from that index
 * rather than by reading every grouped bill: the unary plus keeps the planner
 * off the group key index for them.
 */
export async function countGroups(db: AppDb, filter: SQL | undefined, selective = false): Promise<number> {
  const [all, grouped] = await Promise.all([
    db.all(sql`SELECT COUNT(*) AS n FROM bills m ${filter ? sql`WHERE ${filter}` : sql``}`) as Promise<{ n: number }[]>,
    db.all(sql`SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS bills FROM
      (SELECT COUNT(*) AS n FROM bills m WHERE ${selective ? sql`+m.group_key` : sql`m.group_key`} IS NOT NULL${andFilter(filter)} GROUP BY m.group_key)`) as Promise<{ groups: number; bills: number }[]>,
  ])
  return Number(all[0].n) - Number(grouped[0].bills) + Number(grouped[0].groups)
}

/**
 * How many tracked bills meet the filter, read from the tracked bills alone, so
 * a selective filter is still answered by its own index. It gates the tracked-first
 * fast path: a page is worth trying there only if the tracked bills reach that far.
 * It is not the number of tracked groups (companions both tracked count twice,
 * and a group can be tracked through a bill that doesn't meet the filter), so
 * the fast page itself says whether it filled (`pageOfGroups`).
 */
export async function trackedBills(db: AppDb, filter: SQL | undefined): Promise<number> {
  const rows = await db.all(sql`SELECT COUNT(*) AS n FROM bills m WHERE m.match_type IS NOT NULL${andFilter(filter)}`) as { n: number }[]
  return Number(rows[0].n)
}

/** The keys of up to `limit` groups (all of them without one) with a bill meeting the filter, in no order. For bulk selections. */
export async function matchingGroupKeys(db: AppDb, filter: SQL | undefined, limit?: number): Promise<string[]> {
  const rows = await db.all(sql`SELECT DISTINCT COALESCE(m.group_key, m.id) AS gk FROM bills m ${filter ? sql`WHERE ${filter}` : sql``}${limit === undefined ? sql`` : sql` LIMIT ${limit}`}`) as { gk: string }[]
  return rows.map(r => r.gk)
}

/**
 * Of the groups these bills name (any bill of a group names it), the keys of
 * those with a bill on the new matches worklist: a keyword match, not yet
 * triaged in its group (see `newMatchWhere`).
 */
export async function newMatchGroupsAmong(db: AppDb, billIds: readonly string[], minRelevance: number): Promise<string[]> {
  if (billIds.length === 0) return []
  // One JSON parameter, so any number of bills stays under D1's parameter limit.
  const rows = await db.all(sql`SELECT DISTINCT COALESCE(c.group_key, c.id) AS gk FROM bills c
    WHERE c.id IN (SELECT value FROM json_each(${JSON.stringify(billIds)}))
      AND EXISTS (SELECT 1 FROM bills m WHERE (m.id = c.id OR m.group_key = c.group_key) AND ${newMatchWhere(minRelevance, m)})`) as { gk: string }[]
  return rows.map(r => r.gk)
}

/**
 * The keys of the groups with a bill meeting the filter that are on the new
 * matches worklist (see `newMatchWhere`), in one statement. It starts from the
 * worklist, a small set read through the tracked index, and tests the filter
 * on each group's bills, so a broad filter never lists every group it names.
 */
export async function newMatchGroupKeys(db: AppDb, filter: SQL | undefined, minRelevance: number): Promise<string[]> {
  const rows = await db.all(sql`SELECT DISTINCT COALESCE(c.group_key, c.id) AS gk FROM bills c
    WHERE ${newMatchWhere(minRelevance, c)}${filter ? sql` AND EXISTS (SELECT 1 FROM bills m WHERE (m.id = c.id OR m.group_key = c.group_key) AND ${filter})` : sql``}`) as { gk: string }[]
  return rows.map(r => r.gk)
}

// ── Ordering ────────────────────────────────────────────────────────────────
//
// Sort keys use a group aggregate: the group's current value for a team field
// (lib/teamFields.ts), the furthest-along status, the latest last action, the
// most relevant bill. Every key is a function of the group alone, never of the
// bill that stands for it, so the same group sorts the same way on the
// tracked-first path and the full path, and on every page. A bill with no
// companions skips its group subqueries and reads its own columns.

const CURRENT_YEAR = sql`CAST(strftime('%Y','now') AS INTEGER)`

/** `own` for a bill with no companions, else `over` aggregated across the group of the bill standing for it. */
const aggregate = (own: SQL, over: SQL): SQL =>
  sql`CASE WHEN ${c.groupKey} IS NULL THEN ${own} ELSE (SELECT ${over} FROM bills g WHERE g.group_key = ${c.groupKey}) END`

const priorityRank = (priority: SQL) => sql`CASE ${priority} WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`
const positionRank = (position: SQL) => sql`CASE ${position} WHEN 'Support' THEN 5 WHEN 'Oppose' THEN 4 WHEN 'Amend' THEN 3 WHEN 'Monitor' THEN 2 WHEN 'No Position' THEN 1 ELSE 0 END`

// Natural bill-number order: split into the text before the first digit and the
// number after it, so "HB 9" sorts before "HB 10".
// The digits are inlined, not bound, so the ORDER BY stays well under D1's 100-parameter limit.
const firstDigitPos = (n: SQL) => sql`min(${sql.join(
  Array.from({ length: 10 }, (_, d) => sql`CASE WHEN instr(${n}, ${sql.raw(`'${d}'`)}) = 0 THEN 99999 ELSE instr(${n}, ${sql.raw(`'${d}'`)}) END`),
  sql`, `,
)})`
const billPrefix = (n: SQL) => sql`substr(${n}, 1, ${firstDigitPos(n)} - 1)`
const billNum = (n: SQL) => sql`CAST(substr(${n}, ${firstDigitPos(n)}) AS INTEGER)`

/**
 * The bill number a group is known by: the furthest-along bill's, the first
 * of the group's bills the row shows (see `compareMembers`).
 */
const leadNumber = (): SQL => sql`CASE WHEN ${c.groupKey} IS NULL THEN ${c.billNumber} ELSE
  (SELECT g.bill_number FROM bills g WHERE g.group_key = ${c.groupKey}
   ORDER BY g.status_rank DESC, ${billPrefix(sql`g.bill_number`)} ASC, ${billNum(sql`g.bill_number`)} ASC, g.id ASC LIMIT 1) END`

type KeyName = 'year' | 'yearend' | 'priority' | 'position' | 'relevance' | 'last' | 'status' | 'state' | 'lead' | 'boost'

const KEYS: Record<Exclude<KeyName, 'boost'>, () => SQL> = {
  // The "year" tier: active (non-sine-die) sessions clamp to the current year so they tie at the top,
  // and past sessions keep their real year_end, most recent first. Drafts are exempt from the clamp
  // because a draft's future year_end is deliberate (defaultDraftYear pre-files into the next session).
  year: () => aggregate(
    sql`CASE WHEN ${c.isDraft} THEN COALESCE(${c.yearEnd}, 0) ELSE MIN(COALESCE(${c.yearEnd}, 0), ${CURRENT_YEAR}) END`,
    sql`MAX(CASE WHEN g.is_draft THEN COALESCE(g.year_end, 0) ELSE MIN(COALESCE(g.year_end, 0), ${CURRENT_YEAR}) END)`,
  ),
  yearend: () => aggregate(sql`${c.yearEnd}`, sql`MAX(g.year_end)`),
  // The group's current priority and position are the ones set most recently on any bill in it.
  priority: () => sql`CASE WHEN ${c.groupKey} IS NULL THEN ${priorityRank(sql`${c.priority}`)} ELSE COALESCE(
    (SELECT ${priorityRank(sql`g.priority`)} FROM bills g WHERE g.group_key = ${c.groupKey} AND g.priority IS NOT NULL
     ORDER BY COALESCE(g.priority_set_at, '') DESC, g.id DESC LIMIT 1), 0) END`,
  position: () => sql`CASE WHEN ${c.groupKey} IS NULL
    THEN ${positionRank(sql`(SELECT position FROM official_positions WHERE bill_id = ${c.id})`)}
    ELSE COALESCE((SELECT ${positionRank(sql`p.position`)} FROM official_positions p JOIN bills g ON g.id = p.bill_id WHERE g.group_key = ${c.groupKey}
     ORDER BY p.updated_at DESC, p.bill_id DESC LIMIT 1), 0) END`,
  relevance: () => aggregate(sql`${c.relevanceScore}`, sql`MAX(g.relevance_score)`),
  last: () => aggregate(sql`${c.lastActionDate}`, sql`MAX(g.last_action_date)`),
  // Status: the rank central sends from each provider's vocabulary (stage position times 100 plus the
  // provider's order), so statuses from different providers sort together. The group's is its furthest along.
  status: () => aggregate(sql`${c.statusRank}`, sql`MAX(g.status_rank)`),
  state: () => aggregate(sql`${c.state}`, sql`MIN(g.state)`),
  lead: leadNumber,
}

/**
 * The default hierarchy: five slots, each with the tier it contributes when it
 * isn't the sort column (always best-first) and the tier it makes when it is.
 */
const HIERARCHY: Array<{
  cols: string[]
  secondary: SQL[]
  needs: KeyName[]
  primary: (d: 'asc' | 'desc') => SQL[]
}> = [
  { cols: ['year', 'session'], needs: ['year'], secondary: [sql`k_year DESC`],
    primary: d => [d === 'desc' ? sql`k_year DESC` : sql`k_yearend ASC NULLS LAST`] },
  { cols: ['priority'], needs: ['priority'], secondary: [sql`k_priority DESC`],
    primary: d => [d === 'desc' ? sql`k_priority DESC` : sql`k_priority ASC`] },
  { cols: ['position'], needs: ['position'], secondary: [sql`k_position DESC`],
    primary: d => [d === 'desc' ? sql`k_position DESC` : sql`k_position ASC`] },
  { cols: ['relevance'], needs: ['relevance'], secondary: [sql`k_relevance DESC NULLS LAST`],
    primary: d => [d === 'desc' ? sql`k_relevance DESC NULLS LAST` : sql`k_relevance ASC NULLS FIRST`] },
  { cols: ['lastAction'], needs: ['last'], secondary: [sql`k_last DESC NULLS LAST`],
    primary: d => [d === 'desc' ? sql`k_last DESC NULLS LAST` : sql`k_last ASC NULLS LAST`] },
]

type Order = { tiers: SQL[]; keys: Set<KeyName> }

/** The ORDER BY tiers of a sort, and the sort keys they read, before the final tiebreak (the group key). */
function orderOf(col: string, dir: 'asc' | 'desc', q: string | undefined): Order {
  const keys = new Set<KeyName>()
  const tiers: SQL[] = []
  // When searching, float exact bill-number matches to the very top, above the
  // active sort (which still orders within each group and governs the rest).
  if (buildBillNumberBoost(q)) { keys.add('boost'); tiers.push(sql`k_boost ASC`) }
  // The tiers of every slot but `skip`, best-first.
  const secondary = (skip: number): SQL[] => HIERARCHY.flatMap((h, i) => {
    if (i === skip) return []
    h.needs.forEach(n => keys.add(n))
    return h.secondary
  })
  const slot = col === 'default' ? -1 : HIERARCHY.findIndex(h => h.cols.includes(col))
  if (slot >= 0) {
    // The sort column's own tier leads, and the rest follow in the default order.
    if (col === 'year' || col === 'session') keys.add(dir === 'asc' ? 'yearend' : 'year')
    else HIERARCHY[slot].needs.forEach(n => keys.add(n))
    tiers.push(...HIERARCHY[slot].primary(dir), ...secondary(slot))
  } else if (col === 'status') {
    keys.add('status')
    tiers.push(dir === 'desc' ? sql`k_status DESC` : sql`k_status ASC`, ...secondary(-1))
  } else if (col === 'state') {
    keys.add('state')
    // Descending lists states A to Z, as it always has.
    tiers.push(dir === 'desc' ? sql`k_state ASC` : sql`k_state DESC`, ...secondary(-1))
  } else if (col === 'bill') {
    keys.add('state'); keys.add('lead')
    tiers.push(
      ...(dir === 'asc'
        ? [sql`k_state ASC`, sql`${billPrefix(sql`k_lead`)} ASC`, sql`${billNum(sql`k_lead`)} ASC`]
        : [sql`k_state DESC`, sql`${billPrefix(sql`k_lead`)} DESC`, sql`${billNum(sql`k_lead`)} DESC`]),
      ...secondary(-1),
    )
  } else {
    // The default sort, and any column the list doesn't know.
    tiers.push(...secondary(-1))
  }
  return { tiers, keys }
}

// ── The page ────────────────────────────────────────────────────────────────

export type PageOptions = {
  /** The filter, or undefined for every bill. */
  filter: BillsFilter | undefined
  /**
   * The filter is small enough to appear twice in one statement under D1's
   * parameter limit. The tracked-first path then tests it on a bill with no
   * companions directly, instead of through a lookup of the bill itself.
   */
  twice?: boolean
  /**
   * The filter is also cheap to test on a bill (`isCheapFilter` in query.ts),
   * and `twice`. The full path then reads the filter's bills in one pass and the
   * grouped ones through the group key index, instead of collecting every group
   * they name.
   */
  cheapFilter?: boolean
  /** Take only groups with a tracked bill, from the tracked bills, as the tracked-first fast path does. */
  tracked: boolean
  col: string
  dir: 'asc' | 'desc'
  q: string | undefined
  limit: number
  offset: number
}

/**
 * The tracked-first path: the groups with a tracked bill, from the tracked
 * bills read through their index, each the smallest tracked bill in its group,
 * as conditions on `c`. The group meets the filter when any of its bills does,
 * tested through the group key index. A group counts as tracked if any bill
 * in it is.
 *
 * `filter` is the filter on a bill of the group (`m`), held once. A filter that
 * fits twice also comes as `filterOnC`, on the standing bill itself, which a bill
 * with no companions then tests directly instead of through a lookup of itself.
 */
function trackedStanding(filter: SQL | undefined, filterOnC?: SQL): SQL {
  const standing = sql`${c.matchType} IS NOT NULL
    AND (${c.groupKey} IS NULL OR NOT EXISTS (SELECT 1 FROM bills x WHERE x.group_key = ${c.groupKey} AND x.match_type IS NOT NULL AND x.id < ${c.id}))`
  if (!filter) return standing
  if (filterOnC) {
    return sql`${standing} AND ((${c.groupKey} IS NULL AND ${filterOnC})
      OR (${c.groupKey} IS NOT NULL AND EXISTS (SELECT 1 FROM bills m WHERE m.group_key = ${c.groupKey} AND ${filter})))`
  }
  return sql`${standing} AND EXISTS (SELECT 1 FROM bills m WHERE (m.id = ${c.id} OR m.group_key = ${c.groupKey}) AND ${filter})`
}

/** The keys of the groups on a page, in order. */
export async function pageOfGroups(db: AppDb, o: PageOptions): Promise<string[]> {
  const order = orderOf(o.col, o.dir, o.q)
  const select = sql.join([
    sql`COALESCE(${c.groupKey}, ${c.id}) AS gk`,
    ...[...order.keys].map(k => k === 'boost'
      ? sql`${buildBillNumberBoost(o.q, c)!} AS k_boost`
      : sql`${KEYS[k]()} AS ${sql.raw(`k_${k}`)}`),
  ], sql`, `)
  const tail = sql`ORDER BY ${sql.join([...order.tiers, sql`gk ASC`], sql`, `)} LIMIT ${o.limit} OFFSET ${o.offset}`

  // One bill stands for each group, and the bills that do are found three ways:
  let inner: SQL
  if (o.tracked) {
    // The tracked bills, read through their index (see `trackedStanding`).
    inner = sql`SELECT ${select} FROM bills c WHERE ${trackedStanding(o.filter?.(m), o.twice ? o.filter?.(c) : undefined)}`
  } else if (!o.filter) {
    // Every group, through its key bill (a bill with no companions is its own).
    inner = sql`SELECT ${select} FROM bills c WHERE (${c.groupKey} IS NULL OR ${c.groupKey} = ${c.id})`
  } else if (o.cheapFilter) {
    // The bills with no companions that meet the filter, and the groups of the grouped bills that do, which the
    // group key index finds without reading the table. Each part reads what the filter alone would, as before
    // groups, so a broad filter is not made to build a set of every group it names.
    inner = sql`SELECT ${select} FROM bills c WHERE ${c.groupKey} IS NULL AND ${o.filter(c)}
      UNION ALL SELECT ${select} FROM bills c WHERE ${c.id} IN (SELECT DISTINCT m.group_key FROM bills m WHERE m.group_key IS NOT NULL AND ${o.filter(m)})`
  } else {
    // The groups of the bills meeting the filter, the filter held once: a filter that reads the table is
    // already costly, and tests each bill the way it did before groups.
    inner = sql`SELECT ${select} FROM bills c WHERE ${c.id} IN (SELECT COALESCE(m.group_key, m.id) FROM bills m WHERE ${o.filter(m)})`
  }
  // The natural bill number reads the lead bill's number several times, so its value is computed once per group
  // first. The two parts of the cheap filter's full path are one set to sort, so they are wrapped the same way.
  const statement = order.keys.has('lead')
    ? sql`WITH k AS MATERIALIZED (${inner}) SELECT gk FROM k ${tail}`
    : o.cheapFilter && !o.tracked && o.filter
      ? sql`SELECT gk FROM (${inner}) ${tail}`
      : sql`${inner} ${tail}`
  const rows = await db.all(statement) as { gk: string }[]
  return rows.map(r => r.gk)
}

// ── The rows ────────────────────────────────────────────────────────────────

// The columns a row of the list reads. Not the history, the text, or the other columns of the bill page,
// which are wide and which the list never shows.
const memberColumns = {
  id: bills.id, billNumber: bills.billNumber, title: bills.title, state: bills.state, status: bills.status, statusRank: bills.statusRank,
  session: bills.session, sessionId: bills.sessionId, sessionSlug: bills.sessionSlug, yearStart: bills.yearStart, yearEnd: bills.yearEnd,
  abstract: bills.abstract, url: bills.url, stateUrl: bills.stateUrl, lastAction: bills.lastAction, lastActionDate: bills.lastActionDate,
  tenantSummary: bills.tenantSummary, tags: bills.tags, priority: bills.priority, prioritySetAt: bills.prioritySetAt,
  sponsor: bills.sponsor, sponsorParty: bills.sponsorParty, stateLink: bills.stateLink, matchType: bills.matchType, isDraft: bills.isDraft,
  addedBy: bills.addedBy, relevanceScore: bills.relevanceScore, aiProcessedAt: bills.aiProcessedAt, newMatchAt: bills.newMatchAt,
  triagedAt: bills.triagedAt, triagedBy: bills.triagedBy, lastAiTextDocId: bills.lastAiTextDocId,
  createdAt: bills.createdAt, updatedAt: bills.updatedAt, groupKey: bills.groupKey,
}
type BillRow = Pick<typeof bills.$inferSelect, keyof typeof memberColumns>

/** A bill in a group, as the list row names it. */
export type GroupMemberSummary = { id: string; billNumber: string; state: string; status: string; sessionSlug: string; matched?: boolean }

/** The bills of a group, the furthest along first, then by bill number. The first is the group's lead, the bill the row is about. */
export function compareMembers(a: Pick<BillRow, 'id' | 'billNumber' | 'statusRank'>, b: Pick<BillRow, 'id' | 'billNumber' | 'statusRank'>): number {
  if (a.statusRank !== b.statusRank) return b.statusRank - a.statusRank
  const [x, y] = [naturalParts(a.billNumber), naturalParts(b.billNumber)]
  if (x.prefix !== y.prefix) return x.prefix < y.prefix ? -1 : 1
  if (x.num !== y.num) return x.num - y.num
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// The same split as `billPrefix` and `billNum` above, so the row's first bill is the one the sort used.
function naturalParts(number: string): { prefix: string; num: number } {
  const digit = /\d/.exec(number)
  if (!digit) return { prefix: number, num: 0 }
  return { prefix: number.slice(0, digit.index), num: Number.parseInt(number.slice(digit.index), 10) || 0 }
}

/** A row of the page's one read of everything the team and the viewer have on its bills: its kind, then up to six values. */
type Extra = { kind: string; a: string; b: unknown; c: unknown; d: unknown; e: unknown; f: unknown }

type ViewerContext = {
  userId: string
  /** The list's filter, to mark which bills of a group meet it. Undefined when nothing is filtered. */
  filter: BillsFilter | undefined
  tagTaxonomy: Set<string>
}

/**
 * The rows for these groups, in this order: each group's lead bill, with the
 * team's values, votes, and comments read across the whole group, and the bills
 * of a group listed when it has more than one. Reads every bill of every group
 * on the page in a handful of concurrent statements, each holding the page's
 * group keys as one JSON parameter so a page of any size stays under D1's
 * 100-parameter limit.
 */
export async function loadGroupRows(db: AppDb, groupKeys: readonly string[], ctx: ViewerContext) {
  if (groupKeys.length === 0) return []
  // Every bill of the groups on the page, named by the page's group keys, so no read waits for another to learn the
  // bills' ids. The keys are one JSON parameter, and the bills are found through the primary key and the group key index.
  const keys = JSON.stringify(groupKeys)
  const pageBills = sql`(SELECT value FROM json_each(${keys}) UNION ALL SELECT g.id FROM bills g WHERE g.group_key IN (SELECT value FROM json_each(${keys})))`

  // The bills themselves, and everything the team and the viewer have on them, in two statements: the bills are wide,
  // and the rest are small reads of other tables, put together as one result with a kind in its first column since a
  // statement costs a round trip to D1 however little it reads. D1 allows five terms in a compound SELECT, which
  // is why votes and comments each carry the viewer's own in a column. Whether each bill met the filter is one
  // more column of the first.
  const [memberRows, extras] = await Promise.all([
    db.select({ ...memberColumns, met: ctx.filter ? sql<number>`CASE WHEN ${ctx.filter(bills)!} THEN 1 ELSE 0 END` : sql<number>`0` })
      .from(bills).where(sql`${bills.id} IN ${pageBills}`).all(),
    db.all(sql`WITH pb AS MATERIALIZED (SELECT value AS id FROM json_each(${keys}) UNION SELECT g.id FROM bills g WHERE g.group_key IN (SELECT value FROM json_each(${keys})))
      SELECT 'position' AS kind, ${officialPositions.billId} AS a, ${officialPositions.position} AS b, ${officialPositions.setBy} AS c, ${officialPositions.updatedAt} AS d, NULL AS e, NULL AS f
        FROM official_positions WHERE ${officialPositions.billId} IN (SELECT id FROM pb)
      UNION ALL SELECT 'field', ${billCustomFieldValues.billId}, ${billCustomFieldValues.fieldId}, ${billCustomFieldValues.value}, ${billCustomFieldValues.setBy}, ${billCustomFieldValues.updatedAt}, NULL
        FROM bill_custom_field_values WHERE ${billCustomFieldValues.billId} IN (SELECT id FROM pb)
      UNION ALL SELECT 'vote', ${memberVotes.billId}, ${memberVotes.userId}, ${memberVotes.position}, ${memberVotes.updatedAt}, ${rowidOf(memberVotes)},
          CASE WHEN users.can_vote = 1 AND ${activeUser} THEN 1 ELSE 0 END
        FROM member_votes JOIN users ON users.id = ${memberVotes.userId}
        WHERE ${memberVotes.billId} IN (SELECT id FROM pb) AND ((users.can_vote = 1 AND ${activeUser}) OR ${memberVotes.userId} = ${ctx.userId})
      UNION ALL SELECT 'comments', ${comments.billId}, COUNT(*), SUM(CASE WHEN ${comments.userId} = ${ctx.userId} THEN 1 ELSE 0 END), NULL, NULL, NULL
        FROM comments JOIN users ON users.id = ${comments.userId}
        WHERE ${comments.billId} IN (SELECT id FROM pb) AND ${comments.deletedAt} IS NULL AND ${activeUser} GROUP BY ${comments.billId}
      UNION ALL SELECT 'note', ${notes.billId}, NULL, NULL, NULL, NULL, NULL
        FROM notes WHERE ${notes.userId} = ${ctx.userId} AND ${notes.content} <> '' AND ${notes.billId} IN (SELECT id FROM pb)`) as Promise<Extra[]>,
  ])
  const ofKind = (kind: string) => extras.filter(r => r.kind === kind)
  const positions = ofKind('position').map(r => ({ billId: r.a, position: r.b as string, setBy: r.c as string, updatedAt: r.d as string }))
  const customFields = ofKind('field').map(r => ({ billId: r.a, fieldId: r.b as string, value: r.c as string, setBy: r.d as string, updatedAt: r.e as string }))
  // A member's vote on a group is their latest on any of its bills, so these are every vote and the latest per member is picked below.
  const allVotes = ofKind('vote').map(r => ({ billId: r.a, userId: r.b as string, position: r.c as 'support' | 'oppose' | 'neutral', updatedAt: r.d as string, rowid: Number(r.e), counts: Number(r.f) === 1 }))
  const voteRows = allVotes.filter(v => v.counts)
  const myVoteRows = allVotes.filter(v => v.userId === ctx.userId)
  const commentRows = ofKind('comments').map(r => ({ billId: r.a, count: Number(r.b) }))
  const myCommentRows = ofKind('comments').filter(r => Number(r.c) > 0).map(r => ({ billId: r.a }))
  const myNoteRows = ofKind('note').map(r => ({ billId: r.a }))
  const membersOf = new Map<string, BillRow[]>()
  for (const row of memberRows) membersOf.set(row.groupKey ?? row.id, [...(membersOf.get(row.groupKey ?? row.id) ?? []), row])
  const matched = ctx.filter ? new Set(memberRows.filter(r => Number(r.met) === 1).map(r => r.id)) : null
  const teamRows = {
    bills: memberRows.map(r => ({ id: r.id, priority: r.priority, prioritySetAt: r.prioritySetAt, tenantSummary: r.tenantSummary, tags: r.tags, aiProcessedAt: r.aiProcessedAt, triagedAt: r.triagedAt, triagedBy: r.triagedBy })),
    positions,
    customFields,
  }

  const commentsOn = new Map(commentRows.map(r => [r.billId, Number(r.count)]))
  const myNotes = new Set(myNoteRows.map(r => r.billId))
  const myComments = new Set(myCommentRows.map(r => r.billId))
  const latest = <T extends { updatedAt: string; rowid: number }>(rows: T[]): T | null =>
    rows.reduce<T | null>((best, r) => (best === null || r.updatedAt > best.updatedAt || (r.updatedAt === best.updatedAt && r.rowid > best.rowid) ? r : best), null)

  return groupKeys.flatMap(key => {
    const members = (membersOf.get(key) ?? []).sort(compareMembers)
    if (members.length === 0) return []
    const ids = new Set(members.map(r => r.id))
    const lead = members[0]
    const values: GroupTeamValues = resolveTeamValues(teamRows, ids)

    // A member's latest vote on any bill in the group is their vote, so each member counts once.
    const voteCounts = { support: 0, oppose: 0, neutral: 0 }
    const byMember = new Map<string, typeof voteRows>()
    for (const v of voteRows) if (ids.has(v.billId)) byMember.set(v.userId, [...(byMember.get(v.userId) ?? []), v])
    for (const votes of byMember.values()) voteCounts[latest(votes)!.position]++

    const present = (pick: (r: BillRow) => string | number | null) => members.map(pick).filter((v): v is string | number => v !== null)
    const lastBill = members.reduce<BillRow>((best, r) => ((r.lastActionDate ?? '') > (best.lastActionDate ?? '') ? r : best), lead)
    const relevance = present(r => r.relevanceScore) as number[]
    const newMatchAt = (present(r => r.newMatchAt) as string[]).sort().pop() ?? null
    const matchType = members.some(r => r.matchType === 'keyword') ? 'keyword' : members.some(r => r.matchType === 'manual') ? 'manual' : null

    return [{
      id: lead.id,
      billNumber: lead.billNumber,
      title: lead.title,
      state: lead.state,
      status: lead.status,
      session: lead.session,
      sessionSlug: billSlug(lead),
      sessionId: lead.sessionId,
      yearStart: lead.yearStart ?? null,
      yearEnd: lead.yearEnd ?? null,
      abstract: lead.abstract,
      url: lead.url,
      stateUrl: lead.stateUrl,
      lastAction: lastBill.lastAction,
      lastActionDate: lastBill.lastActionDate,
      // The team summary and tags are the group's current analysis.
      tenantSummary: values.analysis?.tenantSummary ?? null,
      tags: filterTagsToTaxonomy(values.analysis?.tags ?? [], ctx.tagTaxonomy),
      priority: values.priority?.priority ?? null,
      sponsor: lead.sponsor,
      sponsorParty: lead.sponsorParty,
      stateLink: lead.stateLink,
      matchType,
      isDraft: lead.isDraft,
      addedBy: lead.addedBy,
      relevanceScore: relevance.length > 0 ? Math.max(...relevance) : null,
      aiProcessedAt: values.analysis?.aiProcessedAt ?? null,
      newMatchAt,
      triagedAt: values.triaged?.triagedAt ?? null,
      lastAiTextDocId: lead.lastAiTextDocId,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      position: values.position?.position ?? null,
      voteCounts,
      commentCount: members.reduce((n, r) => n + (commentsOn.get(r.id) ?? 0), 0),
      myVote: latest(myVoteRows.filter(v => ids.has(v.billId)))?.position ?? null,
      hasNote: members.some(r => myNotes.has(r.id)),
      hasComment: members.some(r => myComments.has(r.id)),
      customFieldValues: Object.fromEntries([...values.customFields].map(([fieldId, v]) => [fieldId, v.value])),
      // Only a group lists its bills.
      ...(members.length > 1
        ? {
            group: members.map((r): GroupMemberSummary => ({
              id: r.id, billNumber: r.billNumber, state: r.state, status: r.status, sessionSlug: billSlug(r),
              ...(matched ? { matched: matched.has(r.id) } : {}),
            })),
          }
        : {}),
    }]
  })
}
