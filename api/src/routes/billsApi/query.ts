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
import { newMatchWhere } from '../../lib/newMatch'
import { loadTaxonomyTagNameSet } from '../../lib/taxonomy'
import { LEGISCAN_CODE_WORDS } from '../../../../shared/legacyStatusOrder'
import {
  groupHasNoPosition, groupHasNoPriority, heldCustomFieldOf, heldPositionOf,
  holdsGroupPriority, inGroupOfHeld, type BillsTable,
} from '../../lib/teamFields'
import { inGroupsOf, loadVotedInGroups } from '../../lib/companionGroups'
import { FILTER_ANY, FILTER_NONE, type BillFilter, type SubjectValue } from '../../../../shared/billFilter'

/** A second reference to `bills` in one query, with the table's own columns: `billsAs('m').status` renders `"m"."status"`. */
export function billsAs(name: string): BillsTable {
  return alias(bills, name) as unknown as BillsTable
}

/** Any filter, applied to one reference to `bills` (the table, or an alias of it). */
export type BillsFilter = (t: BillsTable) => SQL | undefined

// Membership test: the bill's group tags (the JSON array of its companion
// group's current analysis's tags, its own when it's in no group: migration
// 0103) contain any of `tagValues`.
// Uses json_each rather than `tags LIKE '%"tag"%'` because D1 caps LIKE patterns
// at 50 bytes — a tag name ≥47 chars pushed the old pattern over that limit and
// 500'd the whole query ("LIKE or GLOB pattern too complex: SQLITE_ERROR").
// json_each also matches array elements exactly, avoiding accidental substring
// hits. Shared by the list filter (buildBillsFilter) and the facets WHERE so the
// two can't drift. Caller must pass a non-empty array.
export function tagMembership(tagValues: readonly string[], t: BillsTable = bills): SQL {
  // One JSON parameter, however many tags are picked.
  return sql`EXISTS (SELECT 1 FROM json_each(${t.groupTags}) je WHERE je.value IN (SELECT value FROM json_each(${JSON.stringify(tagValues)})))`
}

/**
 * The bill has group tags. This is the condition of idx_bills_group_tags
 * (0103), which holds only those bills, a few percent of all, so a tag test
 * that names it can start from them rather than from every bill.
 */
export function hasGroupTags(t: BillsTable = bills): SQL {
  return sql`${t.groupTags} <> '[]'`
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
 * value from the bill filter's parse. If every requested value is suppressed the
 * remaining list is empty and the caller adds no subject condition at all —
 * equivalent to the param never having been sent. Shared by buildBillsFilter
 * and the /bills/facets route so the list, filter, and facet-count paths
 * can't drift on this decision.
 */
export function filterSuppressedSubjects(
  values: readonly SubjectValue[],
  suppressed: ReadonlySet<string>,
): readonly SubjectValue[] {
  if (suppressed.size === 0) return values
  return values.filter(v => !isSubjectsSuppressedForState(suppressed, v.state))
}

export function subjectMembership(values: readonly SubjectValue[], t: BillsTable = bills): SQL {
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
export function statusFilterValues(statuses: readonly string[]): string[] {
  return [...new Set(statuses.flatMap(s => LEGISCAN_CODE_WORDS[s] ? [s, LEGISCAN_CODE_WORDS[s]] : [s]))]
}

// Helper: single-value eq or multi-value inArray
export function multiFilter(column: Parameters<typeof eq>[0], values: readonly string[]): SQL | undefined {
  if (values.length === 0) return undefined
  if (values.length === 1) return eq(column, values[0])
  return inArray(column, [...values])
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

/**
 * What building the list's filter takes besides the bill filter itself: the viewer, whose votes and bills the
 * scopes read, and the values a route reads for the filter.
 */
export type BillFilterContext = {
  userId: string
  /** The new matches' minimum relevance (`getNewMatchMinRelevance`). Read only when the filter asks for new matches. */
  newMatchMinRelevance: number
  /** The member's bills (`loadMyBillsInGroups`) when the caller has read them already, so a request reads them once. */
  myBillIds?: readonly string[]
}

/** A condition on one reference to `bills`: the table itself, or an alias of it. */
export type BillsCondition = (t: BillsTable) => SQL

/**
 * Priority filter values (a level, "any" for has a priority, "none" for no
 * priority) as a condition on one bill. A priority belongs to the bill's
 * companion group, so every bill in a group meets the filter when the group's
 * current priority does, and none does through one a newer priority on a
 * companion replaced (see lib/teamFields.ts). Shared by the list filter and
 * the facets so the two can't drift.
 */
export function priorityCondition(priorities: readonly string[]): BillsCondition | undefined {
  if (priorities.length === 0) return undefined
  const hasAny = priorities.includes(FILTER_ANY)
  const hasNone = priorities.includes(FILTER_NONE)
  const real = priorities.filter(v => v !== FILTER_ANY && v !== FILTER_NONE) as ('high' | 'medium' | 'low')[]
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
export function positionCondition(positionValues: readonly string[]): BillsCondition | undefined {
  if (positionValues.length === 0) return undefined
  const hasNone = positionValues.includes(FILTER_NONE)
  const hasAny = positionValues.includes(FILTER_ANY)
  const real = positionValues.filter(pos => pos !== FILTER_NONE && pos !== FILTER_ANY)
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
 * older one. Each bill stores its group's current tags (its group tags), so
 * this tests one column, as the filter did before groups.
 *
 * "Any" means a tag in `taxonomyTags`, the tenant's current taxonomy, as the
 * chips and the options do: a tag an operator removed stays on the bill but no
 * longer counts. A named tag matches whether or not it is still in the taxonomy.
 * The tag facet's "Any tag" count uses this same condition (listRoutes.ts).
 */
export function tagCondition(tagFilters: readonly string[], taxonomyTags: ReadonlySet<string>): BillsCondition | undefined {
  if (tagFilters.length === 0) return undefined
  const hasAny = tagFilters.includes(FILTER_ANY)
  const realTags = tagFilters.filter(t => t !== FILTER_ANY)
  return t => {
    const parts: SQL[] = []
    if (hasAny) parts.push(tagMembership([...taxonomyTags], t))
    if (realTags.length > 0) parts.push(tagMembership(realTags, t))
    return and(hasGroupTags(t), parts.length === 1 ? parts[0] : or(...parts)!)!
  }
}

/**
 * One condition per custom field named by `cf_` params, keyed by the field's id.
 * Shared by the list filter (buildBillsFilter) and the /bills/facets WHERE so the
 * two match stored values the same way and can't drift: a multi-select field
 * stores a JSON array and matches on its elements, every other field matches the
 * stored value exactly. A bill meets one through its group's current value, never
 * one a newer value on a companion replaced (see lib/teamFields.ts).
 *
 * Custom field keys arrive as either the field's id or its slug: the URL (and every
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
  cfParamMap: Readonly<Record<string, readonly string[]>>,
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

/**
 * The ids of the bills a member has voted on, noted, or commented on: the "my
 * bills" scope. Shared by the list filter and the facets' own count of it.
 */
export async function loadMyBillIds(db: ReturnType<typeof getDb>, userId: string): Promise<string[]> {
  const [voteRows, noteRows, commentRows] = await Promise.all([
    db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, userId)).all(),
    db.select({ billId: notes.billId }).from(notes).where(and(eq(notes.userId, userId), ne(notes.content, ''))).all(),
    db.select({ billId: comments.billId }).from(comments).where(and(eq(comments.userId, userId), isNull(comments.deletedAt))).all(),
  ])
  return [...new Set([...voteRows, ...noteRows, ...commentRows].map(r => r.billId))]
}

/**
 * The bills the "my bills" scope keeps: the member's own (`loadMyBillIds`), and
 * every bill in a companion group any of them is in. A member's engagement with
 * a group is with all of it, as their vote is (`loadVotedInGroups`), so a group
 * is one of their bills when any bill of it is, whichever bill the other
 * filters meet. Read once for the request, as a list of ids, so the scope is
 * one `IN` over it on a bill's id, with no probe of the bill's group. A bill in
 * no group is just its own.
 */
export async function loadMyBillsInGroups(db: ReturnType<typeof getDb>, userId: string): Promise<string[]> {
  const mine = await loadMyBillIds(db, userId)
  if (mine.length === 0) return mine
  const rows = await db.select({ id: bills.id }).from(bills).where(inGroupsOf(bills.id, mine)).all()
  return rows.map(r => r.id)
}

/** A bill the member's own: one of `mine` (`loadMyBillsInGroups`), as one JSON parameter, so a member with many bills stays under D1's parameter limit. */
export const myBillsCondition = (mine: readonly string[]): BillsCondition =>
  t => sql`${t.id} IN (SELECT value FROM json_each(${JSON.stringify(mine)}))`

/** A bill the member has not voted on: not one of `voted`, every bill of a group the member voted on any bill of (`loadVotedInGroups`). */
export const unvotedCondition = (voted: readonly string[]): BillsCondition =>
  t => sql`${t.id} NOT IN (SELECT value FROM json_each(${JSON.stringify(voted)}))`

/**
 * The parts of the list's filters, each a condition on one bill, before they are
 * joined into one filter (`composeFilter`). The facets count a dimension with
 * that dimension's own part left out, so they take the parts by name.
 */
export type FilterParts = {
  /** The bill facts, which the group operator joins: each dimension's name (`cf:<field id>` for a custom field) and its condition. */
  facts: Array<{ key: string; condition: BillsCondition }>
  /** The viewer-relative predicates and search, which always narrow. */
  scopes: BillsCondition[]
  /** "My bills" was asked for by a member with none, so nothing matches whatever else is set. */
  noMatch: boolean
  matchAny: boolean
}

/**
 * The list's filters as parts, each a condition on the bill it tests. Filter
 * predicates stay per bill: the bill list asks of each bill in a companion
 * group whether it meets the filter and shows the group if any does (see
 * groupList.ts), and the team's own fields are read through the group's
 * current value (above).
 */
export async function buildFilterParts(
  db: ReturnType<typeof getDb>,
  f: BillFilter,
  ctx: BillFilterContext,
): Promise<FilterParts> {
  // Bill facts render as chip-row groups and are joined by the group operator.
  // Scope conditions (the viewer-relative predicates and search) always
  // AND on top: `(fact1 OP fact2 OP … ) AND search AND myBills AND unvoted …`.
  // See docs/superpowers/specs/2026-09-07-filter-group-operator-design.md.
  const facts: FilterParts['facts'] = []
  const scopes: BillsCondition[] = []

  const statusValues = statusFilterValues(f.status)
  if (statusValues.length > 0) facts.push({ key: 'status', condition: t => multiFilter(t.status, statusValues)! })
  if (f.stage.length > 0) facts.push({ key: 'stage', condition: t => multiFilter(t.statusStage, f.stage)! })

  // Priority is sparse (bills can have none): "Any" = has a priority, "none" = no priority.
  const priority = priorityCondition(f.priority)
  if (priority) facts.push({ key: 'priority', condition: priority })

  if (f.session.length > 0) facts.push({ key: 'session', condition: t => multiFilter(t.session, f.session)! })

  if (f.year.length > 0) {
    facts.push({
      key: 'year',
      condition: t => f.year.length === 1
        ? eq(t.yearStart, Number(f.year[0]))
        : inArray(t.yearStart, f.year.map(Number)),
    })
  }

  if (f.state.length > 0) facts.push({ key: 'state', condition: t => multiFilter(t.state, f.state)! })

  if (f.q && buildSearchCondition(f.q)) scopes.push(t => buildSearchCondition(f.q, t)!)
  if (f.minRelevance !== null) {
    const min = f.minRelevance
    facts.push({ key: 'relevance', condition: t => sql`${t.relevanceScore} >= ${min}` })
  }

  // One condition per custom field; each is a bill fact, so each joins the group operator.
  for (const [fieldId, condition] of Object.entries(await buildCustomFieldFilters(db, f.cf))) {
    facts.push({ key: `cf:${fieldId}`, condition })
  }

  // The taxonomy is read only for "any tag", the one value that depends on it.
  const tag = tagCondition(f.tag, f.tag.includes(FILTER_ANY) ? await loadTaxonomyTagNameSet(db) : new Set())
  if (tag) facts.push({ key: 'tag', condition: tag })

  if (f.subject.length > 0) {
    const suppressed = await loadSuppressedSubjectStates(db)
    const allowed = filterSuppressedSubjects(f.subject, suppressed)
    if (allowed.length > 0) facts.push({ key: 'subject', condition: t => subjectMembership(allowed, t) })
  }

  const position = positionCondition(f.position)
  if (position) facts.push({ key: 'position', condition: position })

  // A member's votes are the group's: unvoted means no vote on any bill in it. One JSON parameter of the bills to leave out.
  if (f.unvoted) scopes.push(unvotedCondition(await loadVotedInGroups(db, ctx.userId)))

  if (f.newMatches) scopes.push(t => newMatchWhere(ctx.newMatchMinRelevance, t))

  if (f.drafts) scopes.push(t => eq(t.isDraft, true))

  let noMatch = false
  if (f.myBills) {
    // A member's engagement is with the group, as unvoted's votes are: a group is mine when any bill of it is.
    const myIds = ctx.myBillIds ?? await loadMyBillsInGroups(db, ctx.userId)
    // Scope, not a bill fact: an empty set means no rows regardless of the group operator.
    if (myIds.length === 0) noMatch = true
    else scopes.push(myBillsCondition(myIds))
  }

  return { facts, scopes, noMatch, matchAny: f.match === 'any' }
}

/**
 * The parts joined into one filter on a bill. `omit` leaves out the named
 * facts, as a facet does for its own dimension, and `facts: false` leaves out
 * every one, keeping the scopes alone.
 */
export function composeFilter(parts: FilterParts, opts: { omit?: ReadonlySet<string>; facts?: boolean } = {}): BillsFilter {
  if (parts.noMatch) return () => sql`1 = 0`
  const kept = opts.facts === false ? [] : parts.facts.filter(f => !opts.omit?.has(f.key))
  return t => {
    const facts = kept.map(f => f.condition(t))
    const factCond = facts.length === 0
      ? undefined
      : facts.length === 1
        ? facts[0]
        : (parts.matchAny ? or(...facts)! : and(...facts)!)

    const all = [...(factCond ? [factCond] : []), ...parts.scopes.map(f => f(t))]
    if (all.length === 0) return undefined
    return all.length === 1 ? all[0] : and(...all)!
  }
}

/** The list's filters as a function of the bill they test, built once and applied to as many references to `bills` as a query needs. */
export async function buildBillsFilter(
  db: ReturnType<typeof getDb>,
  f: BillFilter,
  ctx: BillFilterContext,
): Promise<BillsFilter> {
  return composeFilter(await buildFilterParts(db, f, ctx))
}

/**
 * Whether the filter is cheap to test on a bill: it reads only the bill's own
 * columns that an index carries (status, stage, state, session, year, and
 * relevance) or its id (unvoted), and never a scope or one of the team's values,
 * which are read from other rows. The list tests such a filter on both parts of
 * the full path (groupList.ts, `pageOfGroups`), where a dearer one is tested once.
 */
export function isCheapFilter(f: BillFilter): boolean {
  return f.priority.length === 0 && f.position.length === 0 && f.tag.length === 0 && f.subject.length === 0
    && !f.q && Object.keys(f.cf).length === 0
    && !f.myBills && !f.newMatches && !f.drafts
}
