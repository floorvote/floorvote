import { eq, and, or, like, inArray, sql, ne, isNull, isNotNull, SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, comments, notes,
  customFieldDefinitions,
} from '../../db/schema'
import {
  MAX_SEARCH_TERM_BYTES, MAX_SEARCH_TOKENS, byteLength, truncateToBytes, splitSegments, tokenizeSegment,
} from '../../../../shared/searchLimits'
import { loadSuppressedSubjectStates, isSubjectsSuppressedForState } from '../../lib/billSubjects'
import { LEGISCAN_CODE_WORDS } from '../../../../shared/legacyStatusOrder'
import {
  groupUntriaged, groupHasNoPosition, groupHasNoPriority, heldCustomFieldOf, heldPositionOf,
  holdsGroupAnalysis, holdsGroupPriority, inGroupOfHeld, type BillsTable,
} from '../../lib/teamFields'
import { loadVotedInGroups } from '../../lib/companionGroups'

/** A second reference to `bills` in one query, with the table's own columns: `billsAs('m').status` renders `"m"."status"`. */
export function billsAs(name: string): BillsTable {
  return alias(bills, name) as unknown as BillsTable
}

/**
 * Any filter, applied to one reference to `bills` (the table, or an alias of it).
 * `many` says the statement tests the filter on most bills (a scan), not a few
 * (a page's bills, a lookup of one group's), which the tag filter reads: see `tagCondition`.
 */
export type BillsFilter = (t: BillsTable, many?: boolean) => SQL | undefined

// "New matches" worklist predicate: an un-triaged, fully-analyzed keyword match.
// Shared by the list filter (GET /bills?newMatches=1) and the facet count so they
// can't drift. COALESCE(relevance,0) means with the default threshold 0 a match with
// no relevance score still qualifies; a positive threshold excludes it until scored.
// Triaging any bill in a companion group triages the group, so a bill whose
// companion was triaged is no longer new.
export function newMatchWhere(minRelevance: number, t: BillsTable = bills): SQL {
  return and(
    eq(t.matchType, 'keyword'),
    isNotNull(t.newMatchAt),
    groupUntriaged(t),
    sql`COALESCE(${t.relevanceScore}, 0) >= ${minRelevance}`,
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
// hits. Shared by the list filter (buildBillsFilter) and the facets WHERE so the
// two can't drift. Caller must pass a non-empty array.
export function tagMembership(tagValues: string[], t: BillsTable = bills): SQL {
  // One JSON parameter, however many tags are picked.
  return sql`EXISTS (SELECT 1 FROM json_each(${t.tags}) je WHERE je.value IN (SELECT value FROM json_each(${JSON.stringify(tagValues)})))`
}

/**
 * Bills carrying any of these (state, subject) pairs. An EXISTS against the join
 * table rather than a JSON scan of bills.subjects: idx_bill_subjects_name covers
 * (state, subject_name), so this is an index seek per value.
 */
/**
 * Drop any (state, name) filter value naming an operator-suppressed state (or
 * every state, via "*"). A `subject` query param cannot re-surface a state the
 * operator turned off — rather than making such a value match zero bills
 * (which would read to a caller as "that subject truly has no bills," a
 * confusing and avoidable claim), it is simply ignored, same as a malformed
 * value from decodeSubjectFilters. If every requested value is suppressed the
 * remaining list is empty and the caller adds no subject condition at all —
 * equivalent to the param never having been sent. Shared by buildBillsFilter
 * and the /bills/facets route so the list, filter, and facet-count paths
 * can't drift on this decision.
 */
export function filterSuppressedSubjects(
  values: Array<{ state: string; name: string }>,
  suppressed: ReadonlySet<string>,
): Array<{ state: string; name: string }> {
  if (suppressed.size === 0) return values
  return values.filter(v => !isSubjectsSuppressedForState(suppressed, v.state))
}

export function subjectMembership(values: Array<{ state: string; name: string }>, t: BillsTable = bills): SQL {
  const pairs = sql.join(
    values.map(v => sql`(${v.state}, ${v.name})`),
    sql`, `,
  )
  return sql`EXISTS (
    SELECT 1 FROM bill_subjects bs
    WHERE bs.bill_id = ${t.id} AND (bs.state, bs.subject_name) IN (${pairs})
  )`
}

/**
 * Status filter values, with each bare LegiScan progress code (7 to 12) also
 * matching the word central now sends for it. Bills held the codes until
 * migration 0076 rewrote them, and saved views and links can still name them.
 * Shared by the list filter and the facets so the two can't drift.
 */
export function statusFilterValues(statuses: string[]): string[] {
  return [...new Set(statuses.flatMap(s => LEGISCAN_CODE_WORDS[s] ? [s, LEGISCAN_CODE_WORDS[s]] : [s]))]
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

// Despaced whole-segment bill-number pattern, shared by the WHERE clause and the
// ORDER BY boost so the two can't drift. Returns the '%…%' LIKE pattern, or null
// when the segment is empty or exceeds the byte guard (D1's 50-byte LIKE limit).
export function despacedPattern(segment: string): string | null {
  const despaced = segment.replace(/["\s]+/g, '')
  if (!despaced || byteLength(despaced) > MAX_SEARCH_TERM_BYTES) return null
  return '%' + despaced + '%'
}

// One token matched across all four searchable fields. Bill-number matches are
// additionally floated to the top by buildBillNumberBoost (ORDER BY), so a numeric
// token's summary/abstract hits land below the exact bill-number match.
function matchAllFields(token: string, t: BillsTable): SQL {
  const pat = `%${token}%`
  return or(
    like(t.title, pat),
    like(t.tenantSummary, pat),
    like(t.billNumber, pat),
    like(t.abstract, pat),
  )!
}

// One segment → one condition. Every token matches the four fields; the segment
// also gets an OR'd despaced bill-number match (see despacedPattern). `tokens` are
// already truncated and budgeted by the caller (buildSearchCondition).
function buildSegmentCondition(segment: string, tokens: string[], t: BillsTable): SQL | undefined {
  if (tokens.length === 0) return undefined
  const pat = despacedPattern(segment)
  const despacedCond = pat ? sql`replace(${t.billNumber}, ' ', '') LIKE ${pat}` : undefined
  if (tokens.length === 1) {
    return or(matchAllFields(tokens[0], t), despacedCond)!
  }
  return or(and(...tokens.map(tok => matchAllFields(tok, t)))!, despacedCond)!
}

// The comma-separated segments actually honored under the shared token budget —
// the single source of truth for "which segments a search considers", so the WHERE
// clause (buildSearchCondition) and the ORDER BY boost (buildBillNumberBoost) can't
// diverge on which segments count. Each returned segment has >=1 budgeted token, so
// the number of segments is <= MAX_SEARCH_TOKENS, which bounds both param footprints.
//
// Two D1 limits to respect, both surfaced as 500s:
//  • pattern length — a token >48 bytes makes a '%token%' pattern exceed 50
//    bytes ("LIKE or GLOB pattern too complex"). Guarded by truncateToBytes.
//  • bound params — >100 params per statement ("too many SQL variables"), and
//    each token emits up to ~6 params (4 field LIKEs + 1 despaced WHERE match,
//    plus 1 more for the despaced ORDER BY boost). Guarded by MAX_SEARCH_TOKENS
//    across the whole query (a segment cap alone doesn't bound tokens within one
//    segment, e.g. a long pasted phrase). Segments are still capped first so a
//    comma-bomb can't consume the whole token budget on segment one.
export function budgetedSegments(q: string): { segment: string; tokens: string[] }[] {
  let budget = MAX_SEARCH_TOKENS
  const out: { segment: string; tokens: string[] }[] = []
  for (const segment of splitSegments(q).slice(0, 25)) {
    if (budget <= 0) break
    const tokens = tokenizeSegment(segment).slice(0, budget).map(t => truncateToBytes(t, MAX_SEARCH_TERM_BYTES))
    if (tokens.length === 0) continue
    budget -= tokens.length
    out.push({ segment, tokens })
  }
  return out
}

// Build a search condition for a query string against bill title, summary,
// abstract, and bill number. Comma-separated segments are OR'd; tokens within
// a segment are AND'd; quoted spans match as exact substrings. Returns
// undefined when the query has no usable tokens (callers treat that as "no
// search filter").
export function buildSearchCondition(q: string, t: BillsTable = bills): SQL | undefined {
  const conds: SQL[] = []
  for (const { segment, tokens } of budgetedSegments(q)) {
    const cond = buildSegmentCondition(segment, tokens, t)
    if (cond) conds.push(cond)
  }
  if (conds.length === 0) return undefined
  return conds.length === 1 ? conds[0] : or(...conds)!
}

// Primary sort tier: float groups with a bill whose despaced bill_number matches
// any segment's despaced query pattern ahead of everything else. Reuses
// despacedPattern, so it fires under exactly the same conditions as the WHERE
// despaced clause. For a topic query ("election") the CASE evaluates to 1 for
// every row, so it is self-inert and reorders nothing. Returns undefined only
// when no segment yields a usable pattern. Derives its segments from
// budgetedSegments, the exact set the WHERE clause searches, so it can never
// boost a segment the search dropped, and its param count is bounded to
// <= MAX_SEARCH_TOKENS.
//
// `of` is the bill that stands for its group in the list: the boost looks at
// every bill in that bill's group, so a search for S1713 floats the row
// A190 and S1713 share.
export function buildBillNumberBoost(q: string | undefined, of: BillsTable = bills): SQL | undefined {
  if (!q) return undefined
  const pats = budgetedSegments(q)
    .map(s => despacedPattern(s.segment))
    .filter((p): p is string => p !== null)
  if (pats.length === 0) return undefined
  const matches = pats.map(p => sql`replace(g.bill_number, ' ', '') LIKE ${p}`)
  const anyMatch = matches.length === 1 ? matches[0] : or(...matches)!
  return sql`CASE WHEN EXISTS (SELECT 1 FROM bills g WHERE (g.id = ${of.id} OR g.group_key = ${of.groupKey}) AND ${anyMatch}) THEN 0 ELSE 1 END`
}

export function canOptimize(sort: string, dir: 'asc' | 'desc'): boolean {
  if (sort === 'default') return true
  if (sort === 'priority' && dir === 'desc') return true
  if (sort === 'relevance' && dir === 'desc') return true
  return false
}

export type BillFilterParams = {
  statuses: string[]
  stages: string[]
  priorities: string[]
  positionValues: string[]
  sessions: string[]
  years: string[]
  states: string[]
  tagFilters: string[]
  subjectFilters: Array<{ state: string; name: string }>
  q: string | undefined
  minRelevance: string | undefined
  myBillsParam: string | undefined
  unvoted: string | undefined
  newMatches: string | undefined
  drafts: string | undefined
  newMatchMinRelevance: number
  cfParamMap: Record<string, string[]>
  userId: string
  matchAny: boolean
}

/** A condition on one reference to `bills`: the table itself, or an alias of it. */
export type BillsCondition = (t: BillsTable, many?: boolean) => SQL

/**
 * Priority filter values (a level, "any" for has a priority, "none" for no
 * priority) as a condition on one bill. A priority belongs to the bill's
 * companion group, so every bill in a group meets the filter when the group's
 * current priority does, and none does through one a newer priority on a
 * companion replaced (see lib/teamFields.ts). Shared by the list filter and
 * the facets so the two can't drift.
 */
export function priorityCondition(priorities: string[]): BillsCondition | undefined {
  if (priorities.length === 0) return undefined
  const hasAny = priorities.includes(FILTER_ANY)
  const hasNone = priorities.includes('none')
  const real = priorities.filter(v => v !== FILTER_ANY && v !== 'none') as ('high' | 'medium' | 'low')[]
  const h = billsAs('h')
  // The holder meets it itself. Every other bill in its group meets it through the group key.
  const held = (t: BillsTable, levels: boolean) => or(
    and(levels ? (real.length === 1 ? eq(t.priority, real[0]) : inArray(t.priority, real)) : undefined, holdsGroupPriority(t))!,
    sql`${t.groupKey} IN (SELECT h.group_key FROM bills h WHERE h.group_key IS NOT NULL${levels ? sql` AND ${real.length === 1 ? eq(h.priority, real[0]) : inArray(h.priority, real)}` : sql``} AND ${holdsGroupPriority(h)})`,
  )!
  return t => {
    const parts: SQL[] = []
    if (real.length > 0) parts.push(held(t, true))
    if (hasAny) parts.push(held(t, false))
    if (hasNone) parts.push(groupHasNoPriority(t))
    return parts.length === 1 ? parts[0] : or(...parts)!
  }
}

/**
 * Position filter values (a position, "any", or "none") as a condition on one
 * bill, met by every bill in a group whose current position does, as
 * `priorityCondition` is.
 */
export function positionCondition(positionValues: string[]): BillsCondition | undefined {
  if (positionValues.length === 0) return undefined
  const hasNone = positionValues.includes('none')
  const hasAny = positionValues.includes(FILTER_ANY)
  const real = positionValues.filter(pos => pos !== 'none' && pos !== FILTER_ANY)
  return t => {
    const parts: SQL[] = []
    if (real.length > 0) parts.push(inGroupOfHeld(t, heldPositionOf(real)))
    if (hasAny) parts.push(inGroupOfHeld(t, heldPositionOf([])))
    if (hasNone) parts.push(groupHasNoPosition(t))
    return parts.length === 1 ? parts[0] : or(...parts)!
  }
}

/**
 * Tag filter values ("any", or tags) as a condition on one bill. Tags come from
 * the AI analysis, which a companion group shares: every bill in a group meets
 * the filter when the group's current analysis does, and none through an
 * older one.
 */
export function tagCondition(tagFilters: string[]): BillsCondition | undefined {
  if (tagFilters.length === 0) return undefined
  const hasAny = tagFilters.includes(FILTER_ANY)
  const realTags = tagFilters.filter(t => t !== FILTER_ANY)
  const tagTest = (t: BillsTable): SQL => {
    const parts: SQL[] = []
    if (hasAny) parts.push(sql`json_array_length(${t.tags}) > 0`) // "Any" = has any tag
    if (realTags.length > 0) parts.push(tagMembership(realTags, t))
    return parts.length === 1 ? parts[0] : or(...parts)!
  }
  const h = billsAs('h')
  return (t, many) => many
    // Over most bills: a bill with no companions holds its own analysis, so its tags decide. A grouped bill meets
    // the filter when its group is in a list built once (the groups whose current analysis has the tags), not by a
    // probe of its group for each bill.
    ? sql`CASE WHEN ${t.groupKey} IS NULL THEN ${tagTest(t)}
        ELSE ${t.groupKey} IN (SELECT h.group_key FROM bills h WHERE h.group_key IS NOT NULL AND ${tagTest(h)} AND ${holdsGroupAnalysis(h)}) END`
    // Over a few bills, a probe of the bill's group is cheaper than building that list.
    : or(
      and(tagTest(t), holdsGroupAnalysis(t))!,
      sql`(${t.groupKey} IS NOT NULL AND EXISTS (SELECT 1 FROM bills h WHERE h.group_key = ${t.groupKey} AND ${tagTest(h)} AND ${holdsGroupAnalysis(h)}))`,
    )!
}

/**
 * One condition per custom field named by `cf_` params, keyed by the field's id.
 * Shared by the list filter (buildBillsFilter) and the /bills/facets WHERE so the
 * two match stored values the same way and can't drift: a multi-select field
 * stores a JSON array and matches on its elements, every other field matches the
 * stored value exactly. A bill meets one through its group's current value, never
 * one a newer value on a companion replaced (see lib/teamFields.ts).
 *
 * `cf_` keys arrive as either the field's id or its slug: the URL (and every
 * stored view's query, since views persist the URL's own search string) always
 * uses the slug for readability, but bill_custom_field_values is keyed by id
 * only. Resolve against both columns here so a slug-form key still reaches the
 * right field. A key that matches no definition (a deleted field, or a
 * garbled/stale key) is kept under a sentinel id that can never equal a real
 * field_id, rather than being dropped: dropping it would remove the constraint
 * entirely and silently return every bill instead of the zero bills that filter
 * should produce.
 */
export async function buildCustomFieldFilters(
  db: ReturnType<typeof getDb>,
  cfParamMap: Record<string, string[]>,
): Promise<Record<string, BillsCondition>> {
  const cfKeys = Object.keys(cfParamMap)
  if (cfKeys.length === 0) return {}

  const fieldDefs = await db
    .select({ id: customFieldDefinitions.id, slug: customFieldDefinitions.slug, multiple: customFieldDefinitions.multiple })
    .from(customFieldDefinitions)
    .where(or(inArray(customFieldDefinitions.id, cfKeys), inArray(customFieldDefinitions.slug, cfKeys)))
    .all()

  const resolvedParamMap: Record<string, string[]> = {}
  for (const [key, values] of Object.entries(cfParamMap)) {
    const def = fieldDefs.find(f => f.id === key || f.slug === key)
    const realId = def?.id ?? `__unresolved_cf__:${key}`
    ;(resolvedParamMap[realId] ??= []).push(...values)
  }

  const multipleById = new Map(fieldDefs.map(f => [f.id, f.multiple]))
  const conditions: Record<string, BillsCondition> = {}

  for (const [fieldId, values] of Object.entries(resolvedParamMap)) {
    const realValues = values.filter(v => v !== FILTER_ANY)
    const anyValue = values.includes(FILTER_ANY)
    // One JSON parameter, however many options are picked.
    const picked = sql`(SELECT value FROM json_each(${JSON.stringify(realValues)}))`
    const valueCondition = realValues.length === 0 ? undefined
      : multipleById.get(fieldId)
        // multi-select: stored value is JSON array. Match if any picked value is in the array.
        ? sql`json_valid(p.value) = 1 AND EXISTS (SELECT 1 FROM json_each(p.value) je WHERE je.value IN ${picked})`
        : sql`p.value IN ${picked}`
    if (!anyValue && !valueCondition) continue
    conditions[fieldId] = t => {
      // "Any" = the group has any value for this field.
      const parts: SQL[] = []
      if (anyValue) parts.push(inGroupOfHeld(t, heldCustomFieldOf(fieldId)))
      if (valueCondition) parts.push(inGroupOfHeld(t, heldCustomFieldOf(fieldId, valueCondition)))
      return parts.length === 1 ? parts[0] : or(...parts)!
    }
  }
  return conditions
}

/** Each custom field's condition on the `bills` table, for the facets, which test the one table. */
export async function buildCustomFieldConditions(
  db: ReturnType<typeof getDb>,
  cfParamMap: Record<string, string[]>,
): Promise<Record<string, SQL>> {
  const filters = await buildCustomFieldFilters(db, cfParamMap)
  return Object.fromEntries(Object.entries(filters).map(([fieldId, condition]) => [fieldId, condition(bills)]))
}

/**
 * The list's filters as a function of the bill they test. Filter predicates
 * stay per bill: the bill list asks of each bill in a companion group whether
 * it meets the filter and shows the group if any does (see groupList.ts), and
 * the team's own fields are read through the group's current value (above).
 * Built once, applied to as many references to `bills` as a query needs.
 */
export async function buildBillsFilter(
  db: ReturnType<typeof getDb>,
  p: BillFilterParams,
): Promise<BillsFilter> {
  // Bill facts render as chip-row groups and are joined by the group operator.
  // Scope conditions (the viewer-relative predicates and search) always
  // AND on top: `(fact1 OP fact2 OP … ) AND search AND myBills AND unvoted …`.
  // See docs/superpowers/specs/2026-09-07-filter-group-operator-design.md.
  const billFacts: BillsCondition[] = []
  const scopes: BillsCondition[] = []

  const statusValues = statusFilterValues(p.statuses)
  if (statusValues.length > 0) billFacts.push(t => multiFilter(t.status, statusValues)!)
  if (p.stages.length > 0) billFacts.push(t => multiFilter(t.statusStage, p.stages)!)

  // Priority is sparse (bills can have none): "Any" = has a priority, "none" = no priority.
  const priority = priorityCondition(p.priorities)
  if (priority) billFacts.push(priority)

  if (p.sessions.length > 0) billFacts.push(t => multiFilter(t.session, p.sessions)!)

  if (p.years.length > 0) {
    billFacts.push(t => p.years.length === 1
      ? eq(t.yearStart, Number(p.years[0]))
      : inArray(t.yearStart, p.years.map(Number)))
  }

  if (p.states.length > 0) billFacts.push(t => multiFilter(t.state, p.states)!)

  if (p.q && buildSearchCondition(p.q)) scopes.push(t => buildSearchCondition(p.q!, t)!)
  if (p.minRelevance) {
    const min = parseInt(p.minRelevance, 10)
    billFacts.push(t => sql`${t.relevanceScore} >= ${min}`)
  }

  // One condition per custom field; each is a bill fact, so each joins the group operator.
  billFacts.push(...Object.values(await buildCustomFieldFilters(db, p.cfParamMap)))

  const tag = tagCondition(p.tagFilters)
  if (tag) billFacts.push(tag)

  if (p.subjectFilters.length > 0) {
    const suppressed = await loadSuppressedSubjectStates(db)
    const allowed = filterSuppressedSubjects(p.subjectFilters, suppressed)
    if (allowed.length > 0) billFacts.push(t => subjectMembership(allowed, t))
  }

  const position = positionCondition(p.positionValues)
  if (position) billFacts.push(position)

  // A member's votes are the group's: unvoted means no vote on any bill in it. One JSON parameter of the bills to leave out.
  if (p.unvoted === '1') {
    const voted = JSON.stringify(await loadVotedInGroups(db, p.userId))
    scopes.push(t => sql`${t.id} NOT IN (SELECT value FROM json_each(${voted}))`)
  }

  if (p.newMatches === '1' || p.newMatches === 'true') {
    scopes.push(t => newMatchWhere(p.newMatchMinRelevance, t))
  }

  if (p.drafts === '1' || p.drafts === 'true') {
    scopes.push(t => eq(t.isDraft, true))
  }

  if (p.myBillsParam === '1' || p.myBillsParam === 'true') {
    const [voteRows, noteRows, commentRows] = await Promise.all([
      db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, p.userId)).all(),
      db.select({ billId: notes.billId }).from(notes).where(and(eq(notes.userId, p.userId), ne(notes.content, ''))).all(),
      db.select({ billId: comments.billId }).from(comments).where(and(eq(comments.userId, p.userId), isNull(comments.deletedAt))).all(),
    ])
    const myIds = [...new Set([...voteRows, ...noteRows, ...commentRows].map(r => r.billId))]
    // Scope, not a bill fact: an empty set means no rows regardless of the group
    // operator, so this stays an unconditional early return.
    if (myIds.length === 0) return () => sql`1 = 0`
    // One JSON parameter, so a member with many bills stays under D1's parameter limit.
    const mine = JSON.stringify(myIds)
    scopes.push(t => sql`${t.id} IN (SELECT value FROM json_each(${mine}))`)
  }

  return (t, many) => {
    const facts = billFacts.map(f => f(t, many))
    const factCond = facts.length === 0
      ? undefined
      : facts.length === 1
        ? facts[0]
        : (p.matchAny ? or(...facts)! : and(...facts)!)

    const all = [...(factCond ? [factCond] : []), ...scopes.map(f => f(t, many))]
    if (all.length === 0) return undefined
    return all.length === 1 ? all[0] : and(...all)!
  }
}

/**
 * Whether the filter is cheap to test on a bill: it reads only the bill's own
 * columns that an index carries (status, stage, state, session, year, and
 * relevance) or its id (unvoted), and never a scope or one of the team's values,
 * which are read from other rows. The list tests such a filter on both parts of
 * the full path (groupList.ts, `pageOfGroups`), where a dearer one is tested once.
 */
export function isCheapFilter(p: BillFilterParams): boolean {
  const on = (v: string | undefined) => v === '1' || v === 'true'
  return p.priorities.length === 0 && p.positionValues.length === 0 && p.tagFilters.length === 0 && p.subjectFilters.length === 0
    && !p.q && Object.keys(p.cfParamMap).length === 0
    && !on(p.myBillsParam) && !on(p.newMatches) && !on(p.drafts)
}
