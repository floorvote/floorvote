import { Hono } from 'hono'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { eq, and, or, inArray, sql, ne, isNull, isNotNull, SQL } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, officialPositions, comments, notes, users, billCustomFieldValues, customFieldDefinitions,
  billSubjects,
} from '../../db/schema'
import type { AppEnv } from '../../types'
import { billsAs, buildBillsFilter, isCheapFilter, buildCustomFieldConditions, multiFilter, priorityCondition, positionCondition, tagCondition, statusFilterValues, buildSearchCondition, newMatchWhere, FILTER_ANY, canOptimize, tagMembership, subjectMembership, filterSuppressedSubjects } from './query'
import { billStatesForWildcard } from '../../lib/billStates'
import { getNewMatchMinRelevance } from '../../lib/newMatch'
import { cacheKeyFor, getCachedPage, putCachedPage, listCacheTtl, isPerUserListRequest } from '../../lib/listCache'
import type { CachedListPage } from '../../lib/listCache'
import { activeUser } from '../../lib/accountDeletion'
import { loadTaxonomyTagNameSet } from '../../lib/taxonomy'
import { countGroups, loadGroupRows, pageOfGroups, trackedBills, type PageOptions } from './groupList'
import { decodeSubjectFiltersChecked, encodeSubjectFilter, loadSuppressedSubjectStates, isSubjectsSuppressedForState, MAX_SUBJECT_FILTERS } from '../../lib/billSubjects'

export function registerListRoutes(router: Hono<AppEnv>) {
  // GET /bills — the list, one row per companion group, with optional filters and server-side pagination
  router.get('/', async (c) => {
    const db = getDb(c.env.DB)
    const {
      sort, dir: dirParam, minRelevance,
      myBills: myBillsParam, unvoted, newMatches: newMatchesParam,
      drafts: draftsParam,
      page: pageParam, pageSize: pageSizeParam,
    } = c.req.query()
    const statuses = c.req.queries('status') ?? []
    const stages = c.req.queries('stage') ?? []
    const priorities = c.req.queries('priority') ?? []
    const positionValues = c.req.queries('position') ?? []
    const sessions = c.req.queries('session') ?? []
    const years = c.req.queries('year') ?? []
    const states = c.req.queries('state') ?? []
    const tagFilters = c.req.queries('tag') ?? []
    const subjectDecoded = decodeSubjectFiltersChecked(c.req.queries('subject') ?? [])
    if (subjectDecoded.overflow) {
      return c.json({ error: `Too many subject filters. The maximum is ${MAX_SUBJECT_FILTERS}.` }, 400)
    }
    const subjectFilters = subjectDecoded.filters
    const q = c.req.query('q')
    const matchAny = c.req.query('match') === 'any'
    const sortDir = dirParam === 'asc' ? 'asc' : 'desc' as const

    const page = Math.max(1, parseInt(pageParam ?? '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeParam ?? '50', 10) || 50))
    const offset = (page - 1) * pageSize
    const currentUser = c.get('user')

    const cfParamMap: Record<string, string[]> = {}
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (key.startsWith('cf_')) {
        const fieldId = key.slice(3)
        ;(cfParamMap[fieldId] ??= []).push(value)
      }
    }

    const newMatchesActive = newMatchesParam === '1' || newMatchesParam === 'true'
    const newMatchMinRelevance = newMatchesActive ? await getNewMatchMinRelevance(db) : 0
    const draftsActive = draftsParam === '1' || draftsParam === 'true'

    // A group matches when any bill in it does, so the filter stays a condition
    // on one bill, applied to whichever bill a query is testing (groupList.ts).
    const filterParams = {
      statuses,
      stages,
      priorities,
      positionValues,
      sessions,
      years,
      states,
      tagFilters,
      subjectFilters,
      q,
      minRelevance,
      myBillsParam: myBillsParam === '1' || myBillsParam === 'true' ? '1' : undefined,
      unvoted,
      newMatches: newMatchesActive ? '1' : undefined,
      newMatchMinRelevance,
      drafts: draftsActive ? '1' : undefined,
      cfParamMap,
      userId: currentUser.id,
      matchAny,
    }
    const filter = await buildBillsFilter(db, filterParams)
    const filtered = filter(billsAs('m'))
    // The same filter for the statements that test most bills.
    const filteredMany = filter(billsAs('m'), true)
    const hasFilter = filtered !== undefined
    // A filter is held twice in a statement when that leaves room under D1's 100 bound parameters, which lets the
    // tracked-first path test a bill with no companions directly. A cheap filter that fits twice also gets the full path's two-part form.
    const twice = hasFilter && new SQLiteSyncDialect().sqlToQuery(filtered).params.length * 2 <= 90
    const cheapFilter = twice && isCheapFilter(filterParams)

    // ── Default-list query cache ──────────────────────────────────────────
    // The count+ordered-page query is the expensive, SHARED part (full scan +
    // filesort, identical for all users). Cache only that `{ total, billRows }`
    // pair, where billRows names the groups on the page. Per-user filters
    // (myBills/unvoted) make the bill SET user-specific, so they bypass the
    // cache entirely and always run fresh.
    // newMatches is org-shared but admin-only and low-volume; skip the shared page
    // cache rather than widen the cache key for it.
    const cacheable = !isPerUserListRequest({ myBills: myBillsParam, unvoted }) && !newMatchesActive
    const ttl = listCacheTtl(c.env)
    const cacheKey = cacheable
      ? cacheKeyFor(c.env, {
          statuses, stages, priorities, positionValues, sessions, years, states, tagFilters,
          subjectFilters,
          q, minRelevance, cfParamMap, sort: sort ?? 'default', dir: sortDir, page, pageSize,
          drafts: draftsActive,
        })
      : null

    let total: number
    let groupKeys: string[]

    const cached = cacheKey && ttl > 0 ? await getCachedPage(c.env, cacheKey) : null
    if (cached) {
      total = cached.total
      groupKeys = cached.billRows.map(r => r.id as string)
    } else {
      const sortCol = sort ?? 'default'
      // When a search is active, the bill-number boost can float an UNTRACKED
      // exact match to the top — but the optimize fast path scans only tracked
      // bills, so it would silently drop that match and cause drop/duplicate
      // at the fast/normal pagination seam. Search is a leading-wildcard full scan
      // regardless, so the fast path buys little here; bypass it whenever q is set.
      const optimize = canOptimize(sortCol, sortDir) && !q

      // ── Pagination fast path via matchType ────────────────────────────────
      // A group counts as tracked if any bill in it is. total counts every group
      // that meets the filter, tracked or not. trackedCount is: "how many tracked
      // bills sort ahead of the rest" (a count of bills, which groupList.ts says
      // gates the fast path without being the number of tracked groups). Misreading
      // it as a scope filter produces wrong conclusions about the visible set.
      // Phase 1: counts — always get total; get the tracked count when optimizing
      const [totalGroups, trackedCount] = await Promise.all([
        countGroups(db, filteredMany, newMatchesActive || draftsActive || filterParams.myBillsParam === '1'),
        optimize ? trackedBills(db, filtered) : 0,
      ])
      total = totalGroups

      // Phase 2: the page of groups — fast path or normal path. The tracked-first
      // page is only good when it fills: tracked groups that reach this far make a
      // full page of the list's first groups, and a short page means they don't.
      const sortArgs: Omit<PageOptions, 'tracked'> = { filter: hasFilter ? filter : undefined, twice, cheapFilter, col: sortCol, dir: sortDir, q, limit: pageSize, offset }
      const tryFastPath = optimize && trackedCount > 0 && offset + pageSize <= trackedCount
      const fast = tryFastPath ? await pageOfGroups(db, { ...sortArgs, tracked: true }) : null
      groupKeys = fast !== null && fast.length === pageSize ? fast : await pageOfGroups(db, { ...sortArgs, tracked: false })

      if (cacheKey && ttl > 0) {
        const payload: CachedListPage = { total, billRows: groupKeys.map(id => ({ id })) }
        await putCachedPage(c.env, cacheKey, payload, ttl)
      }
    }

    if (groupKeys.length === 0) {
      return c.json({ bills: [], pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } })
    }

    // Per-page reads: every bill in the groups on this page, and the team's
    // values, votes, and comments across each group. Enrichment is always fresh
    // per request, so a shared cache never leaks one user's state to another.
    const result = await loadGroupRows(db, groupKeys, {
      userId: currentUser.id,
      filter: hasFilter ? filter : undefined,
      tagTaxonomy: await loadTaxonomyTagNameSet(db),
    })

    return c.json({
      bills: result,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  })

  // GET /bills/facets — aggregate counts for all filter dimensions (disjunctive: each dimension's
  // counts are computed without that dimension's own filter, so options remain visible when active)
  router.get('/facets', async (c) => {
    const db = getDb(c.env.DB)
    const currentUser = c.get('user')

    // Parse filter params
    const statuses = c.req.queries('status') ?? []
    const stages = c.req.queries('stage') ?? []
    const priorities = c.req.queries('priority') ?? []
    const positionValues = c.req.queries('position') ?? []
    const sessions = c.req.queries('session') ?? []
    const years = c.req.queries('year') ?? []
    const states = c.req.queries('state') ?? []
    const tagFilters = c.req.queries('tag') ?? []
    const subjectDecoded = decodeSubjectFiltersChecked(c.req.queries('subject') ?? [])
    if (subjectDecoded.overflow) {
      return c.json({ error: `Too many subject filters. The maximum is ${MAX_SUBJECT_FILTERS}.` }, 400)
    }
    const subjectFilters = subjectDecoded.filters

    const q = c.req.query('q')
    const minRelevance = c.req.query('minRelevance')
    const matchAny = c.req.query('match') === 'any'
    const myBillsParam = c.req.query('myBills')
    const unvoted = c.req.query('unvoted')
    const newMatchesParam = c.req.query('newMatches')
    const draftsParam = c.req.query('drafts')
    const draftsActive = draftsParam === '1' || draftsParam === 'true'
    const newMatchesActive = newMatchesParam === '1' || newMatchesParam === 'true'
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'owner'
    // Threshold is only needed for the admin count or when the worklist filter is active.
    const newMatchMinRelevance = (isAdmin || newMatchesActive) ? await getNewMatchMinRelevance(db) : 0

    const cfParamMap: Record<string, string[]> = {}
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (key.startsWith('cf_')) {
        const fieldId = key.slice(3)
        ;(cfParamMap[fieldId] ??= []).push(value)
      }
    }

    // --- Dimensional filters (each omitted for its own facet counts) ---
    const statusFilter = multiFilter(bills.status, statusFilterValues(statuses))
    const stageFilter = multiFilter(bills.statusStage, stages)
    // The team's own filters (priority, position, tags, custom fields) are built once, in query.ts, for the list
    // and the facets alike, so the two test a companion group through its current value the same way.
    const priorityFilter = priorityCondition(priorities)?.(bills)
    const sessionFilter = multiFilter(bills.session, sessions)
    const yearFilter = years.length > 0
      ? (years.length === 1
          ? eq(bills.yearStart, Number(years[0]))
          : inArray(bills.yearStart, years.map(Number)))
      : undefined
    const stateFilter = multiFilter(bills.state, states)

    const tagFilter = tagCondition(tagFilters)?.(bills, true)

    // Loaded unconditionally (not just when a `subject` param is present): the
    // subjects facet's own counts must omit suppressed states even with no
    // active subject filter, and a suppressed value in the filter must not
    // narrow the other dimensions' counts either (see filterSuppressedSubjects).
    const suppressedSubjectStates = await loadSuppressedSubjectStates(db)
    const allowedSubjectFilters = filterSuppressedSubjects(subjectFilters, suppressedSubjectStates)
    const subjectFilter: SQL | undefined = allowedSubjectFilters.length > 0 ? subjectMembership(allowedSubjectFilters) : undefined

    // Which states have subjects at all, with no filter applied (a state-leading
    // index makes this a cheap skip-scan). The `subjects` facet below is scoped
    // by the other active filters, so it can't tell the web app "this state has
    // none" from "a filter hid it". Suppressed states count as having none.
    const subjectStates = (await db.selectDistinct({ state: billSubjects.state }).from(billSubjects).all())
      .map(r => r.state)
      .filter(st => !isSubjectsSuppressedForState(suppressedSubjectStates, st))
      .sort()
    // Every state the instance has bills in, for `*` coverage; absent on an
    // explicit list, and cached per tenant (lib/billStates.ts).
    const billStates = await billStatesForWildcard(db, c.env.TENANT_ID, c.env.STATE)

    const positionFilter = positionCondition(positionValues)?.(bills)

    // --- Base conditions (non-dimensional, apply to all facet queries) ---
    const baseConditions: SQL[] = []

    if (q) {
      const searchCond = buildSearchCondition(q)
      if (searchCond) baseConditions.push(searchCond)
    }
    // minRelevance is a bill fact (it renders a chip), not a scope — it joins the
    // other dimensional filters via the group operator inside buildWhere below,
    // rather than always ANDing on top like the base conditions.
    const minRelevanceFilter: SQL | undefined = minRelevance
      ? sql`${bills.relevanceScore} >= ${parseInt(minRelevance, 10)}`
      : undefined

    // CF conditions tracked separately so each field can be excluded for its own facet counts.
    // Built by the same function as the list filter, so the two can't drift.
    const cfSqlMap = await buildCustomFieldConditions(db, cfParamMap)

    // hasDrafts: does this TENANT have any draft at all, completely unfiltered
    // — no dimensional filters, no myBills/unvoted/newMatches scope. This is
    // the chip-visibility signal (draftCount below stays filtered, for the
    // badge). Computed up front so the myBills early-return below — which
    // otherwise skips straight to an empty facets object — still reports it
    // correctly instead of hard-coding false.
    const [hasDraftRow] = await db.select({ id: bills.id })
      .from(bills)
      .where(eq(bills.isDraft, true))
      .limit(1)
      .all()
    const hasDrafts = hasDraftRow !== undefined

    if (myBillsParam === 'true' || myBillsParam === '1') {
      const [voteRows, noteRows, commentRows] = await Promise.all([
        db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, currentUser.id)).all(),
        db.select({ billId: notes.billId }).from(notes).where(and(eq(notes.userId, currentUser.id), ne(notes.content, ''))).all(),
        db.select({ billId: comments.billId }).from(comments).where(and(eq(comments.userId, currentUser.id), isNull(comments.deletedAt))).all(),
      ])
      const ids = [...new Set([...voteRows, ...noteRows, ...commentRows].map(r => r.billId))]
      if (ids.length > 0) baseConditions.push(inArray(bills.id, ids))
      else return c.json({ status: {}, stage: {}, priority: {}, year: {}, session: {}, state: {}, position: { none: 0 }, tags: {}, subjects: {}, subjectStates, billStates, customFields: {}, myBillsCount: 0, newMatchesCount: 0, unvotedCount: 0, draftCount: 0, hasDrafts })
    }

    // Shared by the `unvoted` scope filter above and unvotedCount below, so
    // there's exactly one definition of "not yet voted" in this file.
    const unvotedPredicate = sql`${bills.id} NOT IN (SELECT bill_id FROM member_votes WHERE user_id = ${currentUser.id})`

    if (unvoted === '1') {
      baseConditions.push(unvotedPredicate)
    }

    // When the worklist filter is active, every dimensional facet respects it too
    // (mirrors how myBills/unvoted scope the facets above).
    if (newMatchesActive) baseConditions.push(newMatchWhere(newMatchMinRelevance))

    // drafts is a scope like unvoted/newMatches, not a bill fact: it always
    // narrows and never joins the group operator.
    const draftPredicate = eq(bills.isDraft, true)
    if (draftsActive) baseConditions.push(draftPredicate)

    // excludeCfFieldId omits that CF field's condition (for CF disjunctive counts).
    // Accepts one id or several — the "other unfiltered fields" facet query needs
    // to drop more than one at once (see the CF facet block below).
    // Bill-fact dimensions (dimFilters, cfParts, minRelevanceFilter) combine via the
    // group operator (OR under match=any, AND otherwise); baseConditions (search,
    // myBills, unvoted, newMatches — viewer scope) always AND on top, mirroring
    // buildBillsFilter in query.ts so facet counts never disagree with the list.
    function buildWhere(excludeCfFieldId?: string | string[], ...dimFilters: (SQL | undefined)[]): SQL | undefined {
      const excludeSet = excludeCfFieldId === undefined
        ? undefined
        : new Set(Array.isArray(excludeCfFieldId) ? excludeCfFieldId : [excludeCfFieldId])
      const cfParts = Object.entries(cfSqlMap)
        .filter(([id]) => !excludeSet?.has(id))
        .map(([, s]) => s)
      const factParts = [...(dimFilters.filter(Boolean) as SQL[]), ...cfParts, ...(minRelevanceFilter ? [minRelevanceFilter] : [])]
      const factCond = factParts.length === 0
        ? undefined
        : factParts.length === 1
          ? factParts[0]
          : (matchAny ? or(...factParts)! : and(...factParts)!)
      const all = [...baseConditions, ...(factCond ? [factCond] : [])]
      return all.length > 0 ? and(...all) : undefined
    }

    // Whether any bill-fact filter is actually set. The OR identity below only
    // holds when there is an existing OR to add a value to: with nothing selected,
    // picking a value NARROWS the list rather than widening it, so counts stay
    // absolute (which is also exactly what AND mode does).
    const factFiltersActive = [
      statusFilter, stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter,
      tagFilter, positionFilter, subjectFilter, minRelevanceFilter,
      ...Object.values(cfSqlMap),
    ].some(Boolean)

    // Per-dimension facet WHERE. Under AND, disjunctive faceting omits only the
    // dimension's own filter (dropping a term from an AND widens the set, which is
    // what we want for "how many would there be if I picked something else here").
    // Under OR (match=any) that logic inverts: a value's marginal contribution to
    // an OR is independent of the other groups, so dropping just one term still
    // narrows the count to bills matching every OTHER active filter — which is
    // wrong (see MUST FIX 1: Clerk/Elections fixture, where the tag facet must
    // not be scoped down to subject-matching bills only). So under match=any every
    // dimensional facet query counts over baseConditions alone, with no bill-fact
    // filters at all — each dimension is evaluated independently of the others.
    function buildFacetWhere(excludeCfFieldId?: string | string[], ...dimFilters: (SQL | undefined)[]): SQL | undefined {
      if (matchAny) return baseConditions.length > 0 ? and(...baseConditions) : undefined
      return buildWhere(excludeCfFieldId, ...dimFilters)
    }

    const statusWhere   = buildFacetWhere(undefined, stageFilter,    priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter)
    const stageWhere    = buildFacetWhere(undefined, statusFilter,   priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter)
    const priorityWhere = buildFacetWhere(undefined, statusFilter,   stageFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter)
    const yearWhere     = buildFacetWhere(undefined, statusFilter,   stageFilter, priorityFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter)
    const stateWhere    = buildFacetWhere(undefined, statusFilter,   stageFilter, priorityFilter, yearFilter, sessionFilter, tagFilter, positionFilter, subjectFilter)
    const positionWhere = buildFacetWhere(undefined, statusFilter,   stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, subjectFilter)
    const tagWhere      = buildFacetWhere(undefined, statusFilter,   stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, positionFilter, subjectFilter)
    const subjectWhere  = buildFacetWhere(undefined, statusFilter,   stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter)
    // Full WHERE (all filters, combined via the group operator) for myBillsCount,
    // newMatchesCount, and as the fallback when no CF field has an active filter —
    // this one must reflect the actual list, not a per-dimension facet count.
    const finalWhere    = buildWhere(undefined, statusFilter,   stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter)

    // Under match=any a facet count is the RESULTING TOTAL — what the list will
    // show if you pick this value — which is what AND mode's disjunctive faceting
    // has always meant. Counting the value's whole population instead made one
    // label answer a different question in each mode, and the arithmetic visibly
    // failed for operators (see the 2026-09-07 spec).
    //
    //   resultingTotal(v) = currentTotal + |{v} ∩ scope ∩ NOT currentResult|
    //
    // The delta is shared across dimensions: under OR, adding v yields
    // currentResult ∪ {v} whichever dimension v came from, so there is no
    // own-dimension term to exclude. It is a conditional aggregate rather than a
    // WHERE term on purpose: filtering the rows by NOT (finalWhere) would drop a
    // value whose bills are ALL already showing out of the GROUP BY entirely, so
    // it would vanish from the dropdown instead of reading "picking this changes
    // nothing". COALESCE guards the three-valued case — finalWhere is NULL, not
    // false, for a row with a NULL column, and such a row is not in the list.
    const shiftFacets = matchAny && factFiltersActive
    // shiftFacets implies at least one bill-fact filter, hence a defined finalWhere;
    // the guard is only so the unused expression is still constructible.
    const notCurrent = finalWhere ? sql`COALESCE((${finalWhere}), 0) = 0` : sql`0`
    const facetCountExpr = shiftFacets
      ? sql<number>`COALESCE(SUM(CASE WHEN ${notCurrent} THEN 1 ELSE 0 END), 0)`
      : sql<number>`COUNT(*)`
    // Distinct-bill variant for the CF "Any" row, which counts bills, not rows.
    const distinctBillCountExpr = shiftFacets
      ? sql`COUNT(DISTINCT CASE WHEN ${notCurrent} THEN bcfv.bill_id END)`
      : sql`COUNT(DISTINCT bcfv.bill_id)`

    const tagWhereClause = tagWhere ? sql`WHERE ${tagWhere}` : sql``

    // Run all dimensional facet queries in parallel — currentTotal joins the
    // same batch rather than being awaited serially ahead of it, and is only
    // queried at all when shiftFacets is active: under AND mode (or with no
    // bill-fact filter active) asResultingTotal is the identity and the value
    // is thrown away, so there is nothing worth a query for.
    const [statusRows, stageRows, priorityRows, sessionRows, yearRows, stateRows, setPositionRows, tagRows, subjectRows, myInteractionRows, noPositionCountRows, tagSet, currentTotalRows] = await Promise.all([
      db.select({ value: bills.status, count: facetCountExpr })
        .from(bills).where(statusWhere).groupBy(bills.status).all(),
      db.select({ value: bills.statusStage, count: facetCountExpr })
        .from(bills).where(stageWhere).groupBy(bills.statusStage).all(),
      db.select({ value: bills.priority, count: facetCountExpr })
        .from(bills).where(priorityWhere).groupBy(bills.priority).all(),
      db.select({ value: bills.session, count: facetCountExpr })
        .from(bills).where(yearWhere).groupBy(bills.session).all(),
      db.select({ value: bills.yearStart, count: facetCountExpr })
        .from(bills).where(yearWhere).groupBy(bills.yearStart).all(),
      db.select({ value: bills.state, count: facetCountExpr })
        .from(bills).where(stateWhere).groupBy(bills.state).all(),
      db.select({ value: officialPositions.position, count: facetCountExpr })
        .from(officialPositions)
        .innerJoin(bills, eq(officialPositions.billId, bills.id))
        .where(positionWhere)
        .groupBy(officialPositions.position).all(),
      db.all(sql`SELECT jt.value as tag, ${facetCountExpr} as cnt FROM bills, json_each(bills.tags) jt ${tagWhereClause} GROUP BY jt.value`) as Promise<{ tag: string; cnt: number }[]>,
      db.select({
        state: billSubjects.state,
        name: billSubjects.subjectName,
        cnt: facetCountExpr,
      })
        .from(billSubjects)
        .innerJoin(bills, eq(bills.id, billSubjects.billId))
        .where(subjectWhere)
        .groupBy(billSubjects.state, billSubjects.subjectName)
        .all(),
      Promise.all([
        db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, currentUser.id)).all(),
        db.select({ billId: notes.billId }).from(notes).where(and(eq(notes.userId, currentUser.id), ne(notes.content, ''))).all(),
        db.select({ billId: comments.billId }).from(comments).where(and(eq(comments.userId, currentUser.id), isNull(comments.deletedAt))).all(),
      ]),
      db.select({ noPositionCount: facetCountExpr })
        .from(bills)
        .where(positionWhere
          ? and(positionWhere, sql`${bills.id} NOT IN (SELECT bill_id FROM official_positions)`)
          : sql`${bills.id} NOT IN (SELECT bill_id FROM official_positions)`)
        .all(),
      loadTaxonomyTagNameSet(db),
      shiftFacets
        ? db.select({ count: sql<number>`COUNT(*)` }).from(bills).where(finalWhere).all()
        : Promise.resolve([{ count: 0 }]),
    ])
    const currentTotal = Number(currentTotalRows[0].count)

    // AND-mode counts are already absolute and pass through untouched.
    const asResultingTotal = (counts: Record<string, number>): Record<string, number> =>
      shiftFacets
        ? Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v + currentTotal]))
        : counts

    // CF facets — disjunctive: each field's counts exclude that field's own active filter.
    // Fields with no active filter are counted together under finalWhere; active-filter fields
    // each get a separate query using buildWhere(fieldId, ...) which omits their own condition.
    const customFields: Record<string, Record<string, number>> = {}
    const cfFieldIds = Object.keys(cfSqlMap)

    // Multi-select fields store their value as a JSON array, so their option counts
    // must json_each-expand it (same as the tag facet) instead of grouping by the raw
    // array string. Single-value fields group by the raw value. We pre-filter to multi
    // field ids in a subquery before json_each so it never sees a non-array scalar.
    const cfDefs = await db.select({ id: customFieldDefinitions.id, multiple: customFieldDefinitions.multiple }).from(customFieldDefinitions).all()
    const multiIds = new Set(cfDefs.filter(d => d.multiple).map(d => d.id))

    // An active `cf_` param that resolves to no real field (deleted field, garbled
    // key — see query.ts's `__unresolved_cf__` sentinel) still lands in cfSqlMap as
    // a condition that matches zero bills. It is not a real facet dimension, so it
    // must never be allowed to narrow (i.e. zero out) any OTHER field's facet WHERE
    // — only its own now-defunct "facet" would ever legitimately exclude it, and
    // nothing queries that. Excluding it explicitly, everywhere its exclusion
    // matters, keeps a stale saved view from blanking every custom-field dropdown.
    const validCfFieldIdSet = new Set(cfDefs.map(d => d.id))
    const unresolvedCfFieldIds = Object.keys(cfSqlMap).filter(id => !validCfFieldIdSet.has(id))
    const idList = (ids: string[]) => sql.join(ids.map(id => sql`${id}`), sql`, `)
    const whereOf = (parts: (SQL | undefined)[]) => {
      const ps = parts.filter(Boolean) as SQL[]
      return ps.length ? sql`WHERE ${sql.join(ps, sql` AND `)}` : sql``
    }

    type CfRow = { field_id: string; opt: string; cnt: number }
    const mergeCfRows = (rows: CfRow[]) => {
      for (const r of rows) {
        if (!customFields[r.field_id]) customFields[r.field_id] = {}
        customFields[r.field_id][r.opt] = Number(r.cnt)
      }
    }
    // Count one slice: single fields group raw; multi fields json_each-expand. When
    // restrictFieldId is set (a field's own disjunctive query), only that field runs.
    // When excludeFieldIds is set instead (the "everyone else" query), every field
    // in that set is excluded from all three statements below — it must cover the
    // single-value GROUP BY, the multi-select json_each expansion, AND the __any__
    // distinct-bill count, or one of those three would leak the excluded fields'
    // rows back in (with the wrong, own-filter-inclusive, WHERE).
    const cfCounts = async (where: SQL | undefined, restrictFieldId?: string, excludeFieldIds?: string[]): Promise<CfRow[]> => {
      const out: CfRow[] = []
      const restrictIsMulti = restrictFieldId ? multiIds.has(restrictFieldId) : undefined
      const excludeCond = excludeFieldIds?.length ? sql`bcfv.field_id NOT IN (${idList(excludeFieldIds)})` : undefined
      if (!restrictFieldId || restrictIsMulti === false) {
        const extra: (SQL | undefined)[] = [where]
        if (restrictFieldId) extra.push(sql`bcfv.field_id = ${restrictFieldId}`)
        else if (multiIds.size) extra.push(sql`bcfv.field_id NOT IN (${idList([...multiIds])})`)
        if (excludeCond) extra.push(excludeCond)
        out.push(...await db.all(sql`SELECT bcfv.field_id AS field_id, bcfv.value AS opt, ${facetCountExpr} AS cnt FROM bill_custom_field_values bcfv INNER JOIN bills ON bills.id = bcfv.bill_id ${whereOf(extra)} GROUP BY bcfv.field_id, bcfv.value`) as CfRow[])
      }
      if ((!restrictFieldId && multiIds.size > 0) || restrictIsMulti === true) {
        const idCond = restrictFieldId ? sql`field_id = ${restrictFieldId}` : sql`field_id IN (${idList([...multiIds])})`
        const multiExtra: (SQL | undefined)[] = [where]
        if (excludeCond) multiExtra.push(excludeCond)
        out.push(...await db.all(sql`SELECT bcfv.field_id AS field_id, je.value AS opt, ${facetCountExpr} AS cnt FROM (SELECT bill_id, field_id, value FROM bill_custom_field_values WHERE ${idCond} AND json_valid(value) = 1) bcfv INNER JOIN bills ON bills.id = bcfv.bill_id INNER JOIN json_each(bcfv.value) je ${whereOf(multiExtra)} GROUP BY bcfv.field_id, je.value`) as CfRow[])
      }
      // "Any" = distinct bills with any value for the field (honest count for the top row).
      const anyExtra: (SQL | undefined)[] = [where]
      if (restrictFieldId) anyExtra.push(sql`bcfv.field_id = ${restrictFieldId}`)
      if (excludeCond) anyExtra.push(excludeCond)
      out.push(...await db.all(sql`SELECT bcfv.field_id AS field_id, ${FILTER_ANY} AS opt, ${distinctBillCountExpr} AS cnt FROM bill_custom_field_values bcfv INNER JOIN bills ON bills.id = bcfv.bill_id ${whereOf(anyExtra)} GROUP BY bcfv.field_id`) as CfRow[])
      return out
    }

    if (cfFieldIds.length === 0) {
      // Route through buildFacetWhere, NOT finalWhere. Under AND the two are
      // identical (buildFacetWhere delegates to buildWhere with the same
      // arguments finalWhere was built from), so AND mode is untouched. Under
      // match=any finalWhere would be fatal: every surviving row satisfies it,
      // so the conditional aggregate's NOT-current test is false for all of
      // them, every option collapses to exactly currentTotal ("picking this
      // changes nothing" for every value), and an option carried only by bills
      // outside the current result produces no row and vanishes from the
      // dropdown. buildFacetWhere keeps the WHERE at the scope, which is what
      // every other dimension does and what the conditional aggregate needs.
      mergeCfRows(await cfCounts(buildFacetWhere(undefined, statusFilter, stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter)))
    } else {
      // Per active field, count with that field's own filter excluded (disjunctive).
      // Also exclude any unresolved (non-existent) cf field ids: they aren't a real
      // dimension, so their always-false condition must never narrow a real field's
      // own disjunctive count either.
      const perFieldResults = await Promise.all(
        cfFieldIds.map(id => cfCounts(buildFacetWhere([id, ...unresolvedCfFieldIds], statusFilter, stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter), id))
      )
      for (const rows of perFieldResults) mergeCfRows(rows)

      // Fields with no active filter of their own all share the same WHERE (none
      // of them has a filter to exclude), so they can be counted in ONE extra
      // call rather than one per field. Excluding cfFieldIds (as excludeFieldIds,
      // the 3rd arg) from the OUTPUT keeps this call from clobbering the per-field
      // results just merged above with counts that wrongly include each filtered
      // field's own condition — exclusion, not merge order, is what keeps that
      // correct. Separately, excluding unresolvedCfFieldIds from the WHERE itself
      // (the 1st arg) keeps a stale/garbled cf_ key from zeroing out every real
      // field's count — see the unresolvedCfFieldIds comment above.
      mergeCfRows(await cfCounts(
        buildFacetWhere(unresolvedCfFieldIds.length ? unresolvedCfFieldIds : undefined, statusFilter, stageFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter, subjectFilter),
        undefined,
        cfFieldIds,
      ))
    }

    // Build dimensional facet count maps
    // Each *Counts map is built from raw per-value numbers (deltas under
    // match=any), any derived sentinel is summed from those, and asResultingTotal
    // shifts the finished map exactly once at the end.
    const statusCounts = asResultingTotal(Object.fromEntries(statusRows.filter(r => r.value).map(r => [r.value!, Number(r.count)])))
    const stageCounts = asResultingTotal(Object.fromEntries(stageRows.filter(r => r.value).map(r => [r.value!, Number(r.count)])))
    const priorityCounts: Record<string, number> = Object.fromEntries(priorityRows.filter(r => r.value).map(r => [r.value!, Number(r.count)]))
    // Priority is sparse: "Not set" = null priority; "Any" = has a priority.
    priorityCounts['none'] = Number(priorityRows.find(r => r.value == null)?.count ?? 0)
    priorityCounts[FILTER_ANY] = (priorityCounts['high'] ?? 0) + (priorityCounts['medium'] ?? 0) + (priorityCounts['low'] ?? 0)
    const priorityCountsOut = asResultingTotal(priorityCounts)
    const sessionCounts = asResultingTotal(Object.fromEntries(sessionRows.filter(r => r.value).map(r => [r.value!, Number(r.count)])))
    const yearCounts = asResultingTotal(Object.fromEntries(
      yearRows.filter(r => r.value != null).map(r => [String(r.value!), Number(r.count)])
    ))
    const stateCounts = asResultingTotal(Object.fromEntries(stateRows.filter(r => r.value).map(r => [r.value!, Number(r.count)])))
    const positionCounts: Record<string, number> = Object.fromEntries(setPositionRows.map(r => [r.value, Number(r.count)]))
    positionCounts['none'] = Number(noPositionCountRows[0].noPositionCount)
    // "Any position" = bills with any position set (one position per bill, so summing is safe).
    positionCounts[FILTER_ANY] = setPositionRows.reduce((a, r) => a + Number(r.count), 0)
    const positionCountsOut = asResultingTotal(positionCounts)
    const tagCounts: Record<string, number> = Object.fromEntries(
      tagRows.filter(r => tagSet.has(r.tag)).map(r => [r.tag, Number(r.cnt)]),
    )
    // "Any tag" = distinct bills with at least one VALID (in-taxonomy) tag (within the tag facet's scope).
    const hasTagCond = tagSet.size > 0
      ? tagMembership([...tagSet])
      : sql`json_array_length(${bills.tags}) > 0`
    const [anyTagRow] = await db.select({ cnt: facetCountExpr }).from(bills)
      .where(tagWhere ? and(tagWhere, hasTagCond) : hasTagCond).all()
    tagCounts[FILTER_ANY] = Number(anyTagRow?.cnt ?? 0)
    const tagCountsOut = asResultingTotal(tagCounts)

    const subjectCounts: Record<string, number> = asResultingTotal(Object.fromEntries(
      subjectRows
        .filter(r => !isSubjectsSuppressedForState(suppressedSubjectStates, r.state))
        .map(r => [encodeSubjectFilter(r.state, r.name), Number(r.cnt)]),
    ))

    // Custom-field options are selectable values like any other, so each field's
    // map shifts too (myBillsCount/newMatchesCount/unvotedCount below do NOT —
    // they describe the current result rather than naming a value you can pick).
    for (const fieldId of Object.keys(customFields)) {
      customFields[fieldId] = asResultingTotal(customFields[fieldId])
    }

    // myBillsCount: how many filtered bills this user has interacted with
    const [myVoteRows, myNoteRows, myCommentRows] = myInteractionRows
    const myIds = new Set([...myVoteRows, ...myNoteRows, ...myCommentRows].map(r => r.billId))
    let myBillsCount = 0
    if (myIds.size > 0) {
      const myIdList = [...myIds]
      const [{ count: mbc }] = await db.select({ count: sql<number>`COUNT(*)` })
        .from(bills)
        .where(finalWhere
          ? and(finalWhere, inArray(bills.id, myIdList))
          : inArray(bills.id, myIdList))
        .all()
      myBillsCount = Number(mbc)
    }

    // newMatchesCount: standing size of the admin triage worklist within the active
    // dimensional filters. Admin/owner only — members never see the chip, so 0.
    let newMatchesCount = 0
    if (isAdmin) {
      const predicate = newMatchWhere(newMatchMinRelevance)
      const [{ count: nmc }] = await db.select({ count: sql<number>`COUNT(*)` })
        .from(bills)
        .where(finalWhere ? and(finalWhere, predicate) : predicate)
        .all()
      newMatchesCount = Number(nmc)
    }

    // unvotedCount: how many filtered bills this user has not voted on yet.
    // Mirrors myBillsCount — same finalWhere, so the badge agrees with the
    // list — and reuses unvotedPredicate rather than a second definition.
    const [{ count: uvc }] = await db.select({ count: sql<number>`COUNT(*)` })
      .from(bills)
      .where(finalWhere ? and(finalWhere, unvotedPredicate) : unvotedPredicate)
      .all()
    const unvotedCount = Number(uvc)

    // draftCount: how many drafts exist within the active dimensional filters.
    // Not gated on isAdmin — drafts are ordinary tracked bills that members vote
    // on, so the chip is theirs too. Zero hides the chip entirely.
    const [{ count: dc }] = await db.select({ count: sql<number>`COUNT(*)` })
      .from(bills)
      .where(finalWhere ? and(finalWhere, draftPredicate) : draftPredicate)
      .all()
    const draftCount = Number(dc)

    return c.json({
      status: statusCounts,
      stage: stageCounts,
      priority: priorityCountsOut,
      year: yearCounts,
      session: sessionCounts,
      state: stateCounts,
      position: positionCountsOut,
      tags: tagCountsOut,
      subjects: subjectCounts,
      subjectStates,
      billStates,
      customFields,
      myBillsCount,
      newMatchesCount,
      unvotedCount,
      draftCount,
      hasDrafts,
    })
  })
}
