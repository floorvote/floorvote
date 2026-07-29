import { eq, and, or, like, desc, asc, inArray, sql, ne, isNull, isNotNull, SQL } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, officialPositions, comments, notes,
  customFieldDefinitions, billCustomFieldValues,
} from '../../db/schema'

// "New matches" worklist predicate: an un-triaged, fully-analyzed keyword match.
// Shared by the list filter (GET /bills?newMatches=1) and the facet count so they
// can't drift. COALESCE(relevance,0) means with the default threshold 0 a match with
// no relevance score still qualifies; a positive threshold excludes it until scored.
export function newMatchWhere(minRelevance: number): SQL {
  return and(
    eq(bills.matchType, 'keyword'),
    isNotNull(bills.newMatchAt),
    isNull(bills.triagedAt),
    sql`COALESCE(${bills.relevanceScore}, 0) >= ${minRelevance}`,
  )!
}

// Sentinel filter value: "has any value in this dimension" (position, custom-field
// dropdowns). Mirrors FILTER_ANY in web/src/pages/BillList/FilterPanel.tsx.
export const FILTER_ANY = '__any__'

// Membership test: the bill's JSON `tags` array contains any of `tagValues`.
// Uses json_each rather than `tags LIKE '%"tag"%'` because D1 caps LIKE patterns
// at 50 bytes — a tag name ≥47 chars pushed the old pattern over that limit and
// 500'd the whole query ("LIKE or GLOB pattern too complex: SQLITE_ERROR").
// json_each also matches array elements exactly, avoiding accidental substring
// hits. Shared by the list filter (buildBillsWhere) and the facets WHERE so the
// two can't drift. Caller must pass a non-empty array.
export function tagMembership(tagValues: string[]): SQL {
  const list = sql.join(tagValues.map(t => sql`${t}`), sql`, `)
  return sql`EXISTS (SELECT 1 FROM json_each(${bills.tags}) je WHERE je.value IN (${list}))`
}

// Helper: single-value eq or multi-value inArray
export function multiFilter(column: Parameters<typeof eq>[0], values: string[]): SQL | undefined {
  if (values.length === 0) return undefined
  if (values.length === 1) return eq(column, values[0])
  return inArray(column, values)
}

// ── Search query parsing ─────────────────────────────────────────────────
// Grammar: comma = OR (binds loosest), space = AND, "quotes" = atomic phrase.
// Deliberately no parentheses and no OR keyword (OR means Oregon on
// multi-state instances). OR-of-ANDs is logically complete for AND/OR queries.
// See docs/superpowers/specs/2026-06-10-multi-bill-search-design.md.

// Split on commas that fall outside double quotes.
function splitSegments(q: string): string[] {
  const segments: string[] = []
  let current = ''
  let inQuotes = false
  for (const ch of q) {
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ',' && !inQuotes) {
      segments.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  segments.push(current)
  return segments.map(s => s.trim()).filter(Boolean)
}

// Quoted spans become single phrase tokens; stray quote chars are stripped so
// an unbalanced quote degrades to a best-effort token search.
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment)) !== null) {
    if (m[1] !== undefined) {
      const text = m[1].trim()
      if (text) tokens.push(text)
    } else {
      const text = m[2].replace(/"/g, '')
      if (text) tokens.push(text)
    }
  }
  return tokens
}

// One segment → one condition. Every segment also gets an OR'd despaced
// bill-number match — "H 7358" despaces to "H7358" and hits the stored
// "H 7358"; text segments despace to something no bill number contains, so
// the clause is inert. No bill-number detection heuristic, by design.
function buildSegmentCondition(segment: string): SQL | undefined {
  const tokens = tokenizeSegment(segment)
  if (tokens.length === 0) return undefined

  const despaced = segment.replace(/["\s]+/g, '')
  const despacedCond = sql`replace(${bills.billNumber}, ' ', '') LIKE ${'%' + despaced + '%'}`

  // Single token (word or phrase): same field set as the historical
  // single-token and whole-quoted branches — title + bill number, no summary.
  if (tokens.length === 1) {
    return or(
      like(bills.title, `%${tokens[0]}%`),
      like(bills.billNumber, `%${tokens[0]}%`),
      despacedCond,
    )!
  }

  // Multi-token: AND over tokens (title/summary/number, matching the
  // historical multi-token branch), OR the whole-segment bill-number match.
  return or(
    and(...tokens.map(t =>
      or(
        like(bills.title, `%${t}%`),
        like(bills.tenantSummary, `%${t}%`),
        like(bills.billNumber, `%${t}%`),
      )!
    ))!,
    despacedCond,
  )!
}

// Build a search condition for a query string against bill title, summary,
// and bill number. Comma-separated segments are OR'd; tokens within a segment
// are AND'd; quoted spans match as exact substrings. Returns undefined when
// the query has no usable tokens (callers treat that as "no search filter").
export function buildSearchCondition(q: string): SQL | undefined {
  const conds = splitSegments(q)
    .slice(0, 25) // D1 caps bound params at 100/query; ~3 per token. Searching the first 25 segments beats a 500.
    .map(buildSegmentCondition)
    .filter((c): c is SQL => c !== undefined)
  if (conds.length === 0) return undefined
  return conds.length === 1 ? conds[0] : or(...conds)!
}

const posSubquery = sql`(SELECT position FROM official_positions WHERE bill_id = ${bills.id})`

// ── Reusable sort expressions (module-level so Drizzle renders column refs correctly) ──
// "Year" tier: active (non-sine-die) sessions clamp to the current year so they tie at the top;
// past sessions keep their real year_end and fall below, most-recent-year first. year_end is an
// immutable proxy for sine_die (LegiScan flips sine_die at the year boundary), and strftime keeps
// the active/past split self-updating at the year rollover. No session_id grouping — within the
// active bucket (and within any past year) the later tiers do the sorting.
const S_ACTIVE_YEAR_DESC = sql`MIN(COALESCE(${bills.yearEnd}, 0), CAST(strftime('%Y','now') AS INTEGER)) DESC`
const S_YEAREND_ASC      = sql`${bills.yearEnd} ASC NULLS LAST`
const S_PRIORITY_DESC = sql`CASE ${bills.priority} WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC`
const S_PRIORITY_ASC  = sql`CASE ${bills.priority} WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END ASC`
const S_POSITION_DESC = sql`CASE WHEN ${posSubquery} = 'Support' THEN 5 WHEN ${posSubquery} = 'Oppose' THEN 4 WHEN ${posSubquery} = 'Amend' THEN 3 WHEN ${posSubquery} = 'Monitor' THEN 2 WHEN ${posSubquery} = 'No Position' THEN 1 ELSE 0 END DESC`
const S_POSITION_ASC  = sql`CASE WHEN ${posSubquery} = 'Support' THEN 5 WHEN ${posSubquery} = 'Oppose' THEN 4 WHEN ${posSubquery} = 'Amend' THEN 3 WHEN ${posSubquery} = 'Monitor' THEN 2 WHEN ${posSubquery} = 'No Position' THEN 1 ELSE 0 END ASC`
const S_RELEVANCE_DESC  = sql`${bills.relevanceScore} DESC NULLS LAST`
const S_RELEVANCE_ASC   = sql`${bills.relevanceScore} ASC NULLS FIRST`
const S_LASTACTION_DESC = sql`${bills.lastActionDate} DESC NULLS LAST`
const S_LASTACTION_ASC  = sql`${bills.lastActionDate} ASC NULLS LAST`

// Status rank: central stores LS codes 0-6 as human labels, 7-12 as numeric strings
const S_STATUS_DESC = sql`CASE ${bills.status} WHEN '12' THEN 1 WHEN 'Pre-filed' THEN 2 WHEN 'Introduced' THEN 3 WHEN '9' THEN 4 WHEN '11' THEN 5 WHEN '10' THEN 6 WHEN 'Engrossed' THEN 7 WHEN 'Enrolled' THEN 8 WHEN 'Failed' THEN 9 WHEN 'Vetoed' THEN 10 WHEN 'Passed' THEN 11 WHEN '7' THEN 12 WHEN '8' THEN 13 ELSE 0 END DESC`
const S_STATUS_ASC  = sql`CASE ${bills.status} WHEN '12' THEN 1 WHEN 'Pre-filed' THEN 2 WHEN 'Introduced' THEN 3 WHEN '9' THEN 4 WHEN '11' THEN 5 WHEN '10' THEN 6 WHEN 'Engrossed' THEN 7 WHEN 'Enrolled' THEN 8 WHEN 'Failed' THEN 9 WHEN 'Vetoed' THEN 10 WHEN 'Passed' THEN 11 WHEN '7' THEN 12 WHEN '8' THEN 13 ELSE 0 END ASC`
// Natural bill-number sort: split bill_number into alphabetic prefix and numeric tail
// so "HB 9" sorts before "HB 10". Sorts by state first, then prefix, then numeric value —
// in a single-state instance state is constant so this collapses to bill-number-only order.
const FIRST_DIGIT_POS = sql`min(
  CASE WHEN instr(${bills.billNumber}, '0') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '0') END,
  CASE WHEN instr(${bills.billNumber}, '1') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '1') END,
  CASE WHEN instr(${bills.billNumber}, '2') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '2') END,
  CASE WHEN instr(${bills.billNumber}, '3') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '3') END,
  CASE WHEN instr(${bills.billNumber}, '4') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '4') END,
  CASE WHEN instr(${bills.billNumber}, '5') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '5') END,
  CASE WHEN instr(${bills.billNumber}, '6') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '6') END,
  CASE WHEN instr(${bills.billNumber}, '7') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '7') END,
  CASE WHEN instr(${bills.billNumber}, '8') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '8') END,
  CASE WHEN instr(${bills.billNumber}, '9') = 0 THEN 99999 ELSE instr(${bills.billNumber}, '9') END
)`
const BILL_PREFIX = sql`substr(${bills.billNumber}, 1, ${FIRST_DIGIT_POS} - 1)`
const BILL_NUM    = sql`CAST(substr(${bills.billNumber}, ${FIRST_DIGIT_POS}) AS INTEGER)`
const S_BILL_ASC  = [asc(bills.state), sql`${BILL_PREFIX} ASC`, sql`${BILL_NUM} ASC`]
const S_BILL_DESC = [desc(bills.state), sql`${BILL_PREFIX} DESC`, sql`${BILL_NUM} DESC`]

// Default hierarchy: 5 logical slots (year/session are coupled as one slot)
// Each slot: cols it represents, its secondary SQL (always desc/best-first), and its primary builder
const SORT_HIERARCHY: Array<{
  cols: string[]
  secondary: SQL[]
  primary: (d: 'asc' | 'desc') => SQL[]
}> = [
  {
    cols: ['year', 'session'],
    secondary: [S_ACTIVE_YEAR_DESC],
    primary: (d) => [d === 'desc' ? S_ACTIVE_YEAR_DESC : S_YEAREND_ASC],
  },
  {
    cols: ['priority'],
    secondary: [S_PRIORITY_DESC],
    primary: (d) => [d === 'desc' ? S_PRIORITY_DESC : S_PRIORITY_ASC],
  },
  {
    cols: ['position'],
    secondary: [S_POSITION_DESC],
    primary: (d) => [d === 'desc' ? S_POSITION_DESC : S_POSITION_ASC],
  },
  {
    cols: ['relevance'],
    secondary: [S_RELEVANCE_DESC],
    primary: (d) => [d === 'desc' ? S_RELEVANCE_DESC : S_RELEVANCE_ASC],
  },
  {
    cols: ['lastAction'],
    secondary: [S_LASTACTION_DESC],
    primary: (d) => [d === 'desc' ? S_LASTACTION_DESC : S_LASTACTION_ASC],
  },
]

export function buildOrderBy(col: string, d: 'asc' | 'desc'): SQL[] {
  // Append bills.id so the total order is fully deterministic — without a unique final key,
  // rows tied on every tier can shuffle across paginated requests (drop/repeat on scroll).
  return [...orderByTiers(col, d), asc(bills.id)]
}

export function canOptimize(sort: string, dir: 'asc' | 'desc'): boolean {
  if (sort === 'default') return true
  if (sort === 'priority' && dir === 'desc') return true
  if (sort === 'relevance' && dir === 'desc') return true
  return false
}

function orderByTiers(col: string, d: 'asc' | 'desc'): SQL[] {
  if (col === 'default') return SORT_HIERARCHY.flatMap(h => h.secondary)

  const slotIdx = SORT_HIERARCHY.findIndex(h => h.cols.includes(col))

  if (slotIdx >= 0) {
    // Column is in hierarchy — move to front, keep rest in order
    const primary = SORT_HIERARCHY[slotIdx].primary(d)
    const rest    = SORT_HIERARCHY.filter((_, i) => i !== slotIdx).flatMap(h => h.secondary)
    return [...primary, ...rest]
  }

  // Column is outside the hierarchy — prepend before full default hierarchy
  const full = SORT_HIERARCHY.flatMap(h => h.secondary)
  switch (col) {
    case 'status': return [d === 'desc' ? S_STATUS_DESC : S_STATUS_ASC, ...full]
    case 'state':  return [d === 'desc' ? asc(bills.state) : desc(bills.state), ...full]
    case 'bill':   return [...(d === 'asc' ? S_BILL_ASC : S_BILL_DESC), ...full]
    default:       return full
  }
}

export type BillFilterParams = {
  statuses: string[]
  priorities: string[]
  positionValues: string[]
  sessions: string[]
  years: string[]
  states: string[]
  tagFilters: string[]
  q: string | undefined
  minRelevance: string | undefined
  myBillsParam: string | undefined
  unvoted: string | undefined
  newMatches: string | undefined
  newMatchMinRelevance: number
  cfParamMap: Record<string, string[]>
  userId: string
}

export async function buildBillsWhere(
  db: ReturnType<typeof getDb>,
  p: BillFilterParams,
): Promise<SQL | undefined> {
  const conditions: SQL[] = []

  const statusFilter = multiFilter(bills.status, p.statuses)
  if (statusFilter) conditions.push(statusFilter)

  // Priority is sparse (bills can have none): "Any" = has a priority, "none" = no priority.
  if (p.priorities.length > 0) {
    const hasAny = p.priorities.includes(FILTER_ANY)
    const hasNone = p.priorities.includes('none')
    const real = p.priorities.filter(v => v !== FILTER_ANY && v !== 'none') as ('high' | 'medium' | 'low')[]
    const parts: SQL[] = []
    if (real.length > 0) parts.push(real.length === 1 ? eq(bills.priority, real[0]) : inArray(bills.priority, real))
    if (hasAny) parts.push(isNotNull(bills.priority))
    if (hasNone) parts.push(isNull(bills.priority))
    if (parts.length > 0) conditions.push(parts.length === 1 ? parts[0] : or(...parts)!)
  }

  const sessionFilter = multiFilter(bills.session, p.sessions)
  if (sessionFilter) conditions.push(sessionFilter)

  const yearFilter = p.years.length > 0
    ? (p.years.length === 1
        ? eq(bills.yearStart, Number(p.years[0]))
        : inArray(bills.yearStart, p.years.map(Number)))
    : undefined
  if (yearFilter) conditions.push(yearFilter)

  const stateFilter = multiFilter(bills.state, p.states)
  if (stateFilter) conditions.push(stateFilter)

  if (p.q) {
    const searchCond = buildSearchCondition(p.q)
    if (searchCond) conditions.push(searchCond)
  }
  if (p.minRelevance) conditions.push(sql`${bills.relevanceScore} >= ${parseInt(p.minRelevance, 10)}`)

  if (Object.keys(p.cfParamMap).length > 0) {
    const fieldIds = Object.keys(p.cfParamMap)
    const fieldDefs = await db
      .select({ id: customFieldDefinitions.id, multiple: customFieldDefinitions.multiple })
      .from(customFieldDefinitions)
      .where(inArray(customFieldDefinitions.id, fieldIds))
      .all()
    const multipleById = new Map(fieldDefs.map(f => [f.id, f.multiple]))

    for (const [fieldId, values] of Object.entries(p.cfParamMap)) {
      const realValues = values.filter(v => v !== FILTER_ANY)
      const parts: SQL[] = []
      // "Any" = the bill has any value for this field.
      if (values.includes(FILTER_ANY)) {
        parts.push(sql`${bills.id} IN (SELECT bill_id FROM bill_custom_field_values WHERE field_id = ${fieldId})`)
      }
      if (realValues.length > 0) {
        if (multipleById.get(fieldId)) {
          // multi-select: stored value is JSON array; match if any picked value is in the array
          parts.push(sql`${bills.id} IN (
            SELECT cfv.bill_id FROM bill_custom_field_values cfv
            INNER JOIN json_each(cfv.value) je
            WHERE cfv.field_id = ${fieldId}
              AND json_valid(cfv.value) = 1
              AND je.value IN (${sql.join(realValues.map(v => sql`${v}`), sql`, `)})
          )`)
        } else {
          parts.push(inArray(bills.id,
            db.select({ billId: billCustomFieldValues.billId }).from(billCustomFieldValues)
              .where(and(eq(billCustomFieldValues.fieldId, fieldId),
                realValues.length === 1 ? eq(billCustomFieldValues.value, realValues[0]) : inArray(billCustomFieldValues.value, realValues)
              ))
          ))
        }
      }
      if (parts.length > 0) conditions.push(parts.length === 1 ? parts[0] : or(...parts)!)
    }
  }

  if (p.tagFilters.length > 0) {
    const hasAny = p.tagFilters.includes(FILTER_ANY)
    const realTags = p.tagFilters.filter(t => t !== FILTER_ANY)
    const parts: SQL[] = []
    if (hasAny) parts.push(sql`json_array_length(${bills.tags}) > 0`) // "Any" = has any tag
    if (realTags.length > 0) parts.push(tagMembership(realTags))
    if (parts.length > 0) conditions.push(parts.length === 1 ? parts[0] : or(...parts)!)
  }

  if (p.positionValues.length > 0) {
    const hasNone = p.positionValues.includes('none')
    const hasAny = p.positionValues.includes(FILTER_ANY)
    const realPositions = p.positionValues.filter(pos => pos !== 'none' && pos !== FILTER_ANY)
    const parts: SQL[] = []
    if (realPositions.length > 0) {
      parts.push(inArray(bills.id,
        db.select({ id: officialPositions.billId }).from(officialPositions)
          .where(realPositions.length === 1
            ? eq(officialPositions.position, realPositions[0])
            : inArray(officialPositions.position, realPositions))
      ))
    }
    if (hasAny) parts.push(sql`${bills.id} IN (SELECT bill_id FROM official_positions)`)
    if (hasNone) parts.push(sql`${bills.id} NOT IN (SELECT bill_id FROM official_positions)`)
    if (parts.length > 0) conditions.push(parts.length === 1 ? parts[0] : or(...parts)!)
  }

  if (p.unvoted === '1') {
    conditions.push(sql`${bills.id} NOT IN (SELECT bill_id FROM member_votes WHERE user_id = ${p.userId})`)
  }

  if (p.newMatches === '1' || p.newMatches === 'true') {
    conditions.push(newMatchWhere(p.newMatchMinRelevance))
  }

  if (p.myBillsParam === '1' || p.myBillsParam === 'true') {
    const [voteRows, noteRows, commentRows] = await Promise.all([
      db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, p.userId)).all(),
      db.select({ billId: notes.billId }).from(notes).where(and(eq(notes.userId, p.userId), ne(notes.content, ''))).all(),
      db.select({ billId: comments.billId }).from(comments).where(and(eq(comments.userId, p.userId), isNull(comments.deletedAt))).all(),
    ])
    const myIds = [...new Set([...voteRows, ...noteRows, ...commentRows].map(r => r.billId))]
    if (myIds.length === 0) return sql`1 = 0`
    conditions.push(inArray(bills.id, myIds))
  }

  return conditions.length > 0 ? and(...conditions) : undefined
}
