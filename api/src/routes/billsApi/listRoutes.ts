import { Hono } from 'hono'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { eq, and, sql, SQL } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { bills, customFieldDefinitions } from '../../db/schema'
import type { AppEnv } from '../../types'
import { billsAs, buildBillsFilter, buildFilterParts, composeFilter, isCheapFilter, loadMyBillIds, myBillsCondition, unvotedCondition, newMatchWhere, FILTER_ANY, canOptimize, tagMembership, hasGroupTags, type BillsFilter } from './query'
import { getNewMatchMinRelevance } from '../../lib/newMatch'
import { cacheKeyFor, getCachedPage, putCachedPage, listCacheTtl, isPerUserListRequest } from '../../lib/listCache'
import type { CachedListPage } from '../../lib/listCache'
import { loadTaxonomyTagNameSet } from '../../lib/taxonomy'
import { holdsGroupPriority, holdsGroupValue, type BillsTable } from '../../lib/teamFields'
import { loadVotedInGroups } from '../../lib/companionGroups'
import { countGroups, loadGroupRows, pageOfGroups, trackedBills, type PageOptions } from './groupList'
import { countBy, countHolders, freshOf, type Counting, type CountRow } from './facetCounts'
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
        countGroups(db, filtered,newMatchesActive || draftsActive || filterParams.myBillsParam === '1'),
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
  // counts are computed without that dimension's own filter, so options remain visible when active).
  // Every count counts companion groups once (facetCounts.ts).
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

    // The facets' filters are the list's own, built once in query.ts, so the two can't drift: each is a
    // condition on one bill, and a companion group meets it when a bill of it does (facetCounts.ts).
    // Bill facts join by the group operator, and the scopes (search, my bills, unvoted, new matches,
    // drafts) always narrow. A dimension's facet leaves its own fact out.
    const parts = await buildFilterParts(db, {
      statuses, stages, priorities, positionValues, sessions, years, states, tagFilters, subjectFilters, q, minRelevance,
      myBillsParam: myBillsParam === '1' || myBillsParam === 'true' ? '1' : undefined,
      unvoted,
      newMatches: newMatchesActive ? '1' : undefined,
      newMatchMinRelevance,
      drafts: draftsActive ? '1' : undefined,
      cfParamMap,
      userId: currentUser.id,
      matchAny,
    })

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

    if (parts.noMatch) {
      return c.json({ status: {}, stage: {}, priority: {}, year: {}, session: {}, state: {}, position: { none: 0 }, tags: {}, subjects: {}, customFields: {}, myBillsCount: 0, newMatchesCount: 0, unvotedCount: 0, draftCount: 0, hasDrafts })
    }

    // Loaded unconditionally (not just when a `subject` param is present): the
    // subjects facet's own counts must omit suppressed states even with no
    // active subject filter, and a suppressed value in the filter must not
    // narrow the other dimensions' counts either (see filterSuppressedSubjects).
    const suppressedSubjectStates = await loadSuppressedSubjectStates(db)

    // The list's filter in full: the current result, which myBillsCount, newMatchesCount, unvotedCount,
    // draftCount, and an OR facet's resulting total are counted within.
    const current = composeFilter(parts)
    // Whether any bill-fact filter is actually set. The OR identity below only
    // holds when there is an existing OR to add a value to: with nothing selected,
    // picking a value NARROWS the list rather than widening it, so counts stay
    // absolute (which is also exactly what AND mode does).
    const factFiltersActive = parts.facts.length > 0

    // Per-dimension facet filter. Under AND, disjunctive faceting omits only the
    // dimension's own filter (dropping a term from an AND widens the set, which is
    // what we want for "how many would there be if I picked something else here").
    // Under OR (match=any) that logic inverts: a value's marginal contribution to
    // an OR is independent of the other groups, so dropping just one term still
    // narrows the count to bills matching every OTHER active filter — which is
    // wrong (see MUST FIX 1: Clerk/Elections fixture, where the tag facet must
    // not be scoped down to subject-matching bills only). So under match=any every
    // dimensional facet query counts over the scopes alone, with no bill-fact
    // filters at all — each dimension is evaluated independently of the others.
    const scopesOnly = composeFilter(parts, { facts: false })
    const filterWithout = (omit: string[]): BillsFilter => matchAny ? scopesOnly : composeFilter(parts, { omit: new Set(omit) })

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
    // own-dimension term to exclude. It counts GROUPS, so a group a different
    // bill of which is already in the current result is not added again: `fresh`
    // is true of a bill of a group none of whose bills is in it. It is a
    // conditional count rather than a WHERE term on purpose: filtering the rows
    // by NOT current would drop a value whose bills are ALL already showing out
    // of the GROUP BY entirely, so it would vanish from the dropdown instead of
    // reading "picking this changes nothing".
    const shiftFacets = matchAny && factFiltersActive
    const fresh = shiftFacets ? freshOf(current) : undefined
    const counting = (...omit: string[]): Counting => ({ where: filterWithout(omit), fresh })

    // The count of all groups a facet's filter meets, to name the groups with none of a team field by
    // subtraction (they are the rest). Under AND the dimension's own fact is left out, so a dimension
    // that is not filtered shares one count with the others.
    const totals = new Map<string, Promise<number>>()
    const groupsMeeting = (omit: string) => {
      const key = !matchAny && parts.facts.some(f => f.key === omit) ? omit : ''
      if (!totals.has(key)) totals.set(key, countBy(db, counting(omit), { values: [], from: sql`bills m` }).then(rows => rows[0].n))
      return totals.get(key)!
    }
    const countsOf = (rows: CountRow[], keep: (value: unknown) => boolean = Boolean) => Object.fromEntries(rows.filter(r => keep(r.values[0])).map(r => [String(r.values[0]), r.n]))

    // Custom fields. Multi-select fields store their value as a JSON array, so their option counts
    // must json_each-expand it (same as the tag facet) instead of grouping by the raw
    // array string. Single-value fields group by the raw value.
    const cfDefs = await db.select({ id: customFieldDefinitions.id, multiple: customFieldDefinitions.multiple }).from(customFieldDefinitions).all()
    const multiIds = new Set(cfDefs.filter(d => d.multiple).map(d => d.id))
    const cfFieldIds = parts.facts.filter(f => f.key.startsWith('cf:')).map(f => f.key.slice(3))

    // An active `cf_` param that resolves to no real field (deleted field, garbled
    // key — see query.ts's `__unresolved_cf__` sentinel) still lands in the filter as
    // a condition that matches zero bills. It is not a real facet dimension, so it
    // must never be allowed to narrow (i.e. zero out) any OTHER field's facet filter
    // — only its own now-defunct "facet" would ever legitimately exclude it, and
    // nothing queries that. Excluding it explicitly, everywhere its exclusion
    // matters, keeps a stale saved view from blanking every custom-field dropdown.
    const validCfFieldIdSet = new Set(cfDefs.map(d => d.id))
    const unresolvedCfFieldIds = cfFieldIds.filter(id => !validCfFieldIdSet.has(id))
    const idList = (ids: string[]) => sql.join(ids.map(id => sql`${id}`), sql`, `)
    const cfOmit = (...ids: string[]) => ids.map(id => `cf:${id}`)

    // Custom field values are held, one per field per group, by the bill with the group's current one.
    const cfFrom = sql`bill_custom_field_values p CROSS JOIN bills me ON me.id = p.bill_id`
    const cfHolds = holdsGroupValue('bill_custom_field_values')
    type CfRow = { field_id: string; opt: string; cnt: number }
    const customFields: Record<string, Record<string, number>> = {}
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
    // count, or one of those three would leak the excluded fields'
    // rows back in (with the wrong, own-filter-inclusive, WHERE).
    const cfCounts = async (counts: Counting, restrictFieldId?: string, excludeFieldIds?: string[]): Promise<CfRow[]> => {
      const restrictIsMulti = restrictFieldId ? multiIds.has(restrictFieldId) : undefined
      const excludeCond = excludeFieldIds?.length ? sql`p.field_id NOT IN (${idList(excludeFieldIds)})` : undefined
      const holding = (...extra: (SQL | undefined)[]) => sql.join([cfHolds, ...extra.filter((e): e is SQL => e !== undefined)], sql` AND `)
      const [single, multi, any] = await Promise.all([
        !restrictFieldId || restrictIsMulti === false
          ? countHolders(db, counts, {
              values: [sql`p.field_id`, sql`p.value`], from: cfFrom,
              holds: holding(restrictFieldId ? sql`p.field_id = ${restrictFieldId}` : multiIds.size ? sql`p.field_id NOT IN (${idList([...multiIds])})` : undefined, excludeCond),
            })
          : [],
        (!restrictFieldId && multiIds.size > 0) || restrictIsMulti === true
          ? countHolders(db, counts, {
              values: [sql`p.field_id`, sql`je.value`],
              from: sql`(SELECT bill_id, field_id, value, updated_at FROM bill_custom_field_values WHERE ${restrictFieldId ? sql`field_id = ${restrictFieldId}` : sql`field_id IN (${idList([...multiIds])})`} AND json_valid(value) = 1) p
                CROSS JOIN bills me ON me.id = p.bill_id JOIN json_each(p.value) je`,
              holds: holding(excludeCond),
            })
          : [],
        // "Any" = the groups with any value for the field (honest count for the top row).
        countHolders(db, counts, { values: [sql`p.field_id`], from: cfFrom, holds: holding(restrictFieldId ? sql`p.field_id = ${restrictFieldId}` : undefined, excludeCond) }),
      ])
      return [
        ...[...single, ...multi].map(r => ({ field_id: String(r.values[0]), opt: String(r.values[1]), cnt: r.n })),
        ...any.map(r => ({ field_id: String(r.values[0]), opt: FILTER_ANY, cnt: r.n })),
      ]
    }

    const tagSet = await loadTaxonomyTagNameSet(db)
    // "Any tag" = a valid (in-taxonomy) tag.
    const hasTagCond = (t: BillsTable): SQL => tagSet.size > 0 ? tagMembership([...tagSet], t) : sql`json_array_length(${t.groupTags}) > 0`
    const mine = await loadMyBillIds(db, currentUser.id)
    const voted = await loadVotedInGroups(db, currentUser.id)
    const m = billsAs('m')
    const me = billsAs('me')
    const currentOnM = current(m)
    const both = (a: SQL | undefined, b: SQL): SQL => (a ? and(a, b)! : b)

    // Custom fields: each field with an active filter of its own is counted with that filter left out (disjunctive).
    // Fields with no active filter share one count, and leaving the filtered ones out of its output, not the merge
    // order, keeps their own counts from being overwritten by ones that include their own filter. Separately,
    // leaving unresolvedCfFieldIds out of the filter keeps a stale/garbled cf_ key from zeroing every real field's count.
    const customFieldCounts = (async () => {
      if (cfFieldIds.length === 0) {
        mergeCfRows(await cfCounts(counting()))
        return
      }
      const perField = await Promise.all(cfFieldIds.map(id => cfCounts(counting(...cfOmit(id, ...unresolvedCfFieldIds)), id)))
      for (const rows of perField) mergeCfRows(rows)
      mergeCfRows(await cfCounts(counting(...cfOmit(...unresolvedCfFieldIds)), undefined, cfFieldIds))
    })()

    // Run all dimensional facet queries in parallel. The list's total joins the same batch, but is only
    // queried at all when shiftFacets is active: under AND mode (or with no bill-fact filter active) the
    // shift is the identity and the value is thrown away, so there is nothing worth a query for.
    const [
      statusRows, stageRows, sessionRows, yearRows, stateRows, subjectRows, priorityRows, positionRows, tagRows, anyTagRows,
      currentTotal, myBillsCount, newMatchesCount, unvotedCount, draftCount,
    ] = await Promise.all([
      countBy(db, counting('status'), { values: [sql`${m.status}`], from: sql`bills m` }),
      countBy(db, counting('stage'), { values: [sql`${m.statusStage}`], from: sql`bills m` }),
      countBy(db, counting('year'), { values: [sql`${m.session}`], from: sql`bills m` }),
      countBy(db, counting('year'), { values: [sql`${m.yearStart}`], from: sql`bills m` }),
      countBy(db, counting('state'), { values: [sql`${m.state}`], from: sql`bills m` }),
      countBy(db, counting('subject'), { values: [sql`bs.state`, sql`bs.subject_name`], from: sql`bill_subjects bs JOIN bills m ON m.id = bs.bill_id` }),
      // The team's own fields are the group's current value, held by one bill: a group counts under that bill's value.
      countHolders(db, counting('priority'), { values: [sql`${me.priority}`], from: sql`bills me`, holds: sql`${me.priority} IN ('high', 'medium', 'low') AND ${holdsGroupPriority(me)}` }),
      countHolders(db, counting('position'), { values: [sql`p.position`], from: sql`official_positions p CROSS JOIN bills me ON me.id = p.bill_id`, holds: holdsGroupValue('official_positions') }),
      // Every bill of a group has the group's current tags as its group tags, so tags count as a fact about each
      // bill does, starting from the few bills that have any.
      countBy(db, counting('tag'), { values: [sql`jt.value`], from: sql`bills m, json_each(${m.groupTags}) jt`, where: hasGroupTags(m) }),
      countBy(db, counting('tag'), { values: [], from: sql`bills m`, where: and(hasGroupTags(m), hasTagCond(m)) }),
      shiftFacets ? countGroups(db, currentOnM) : Promise.resolve(0),
      // The counts beside the facets: the groups of the current result with a bill of the kind each names.
      mine.length > 0 ? countGroups(db, both(currentOnM, myBillsCondition(mine)(m)), true) : Promise.resolve(0),
      isAdmin ? countGroups(db, both(currentOnM, newMatchWhere(newMatchMinRelevance, m)), true) : Promise.resolve(0),
      countGroups(db, both(currentOnM, unvotedCondition(voted)(m))),
      // Most tenants have no drafts, where a count read through the draft index would still read the table (it holds one value).
      hasDrafts ? countGroups(db, both(currentOnM, eq(m.isDraft, true))) : Promise.resolve(0),
      customFieldCounts,
    ])

    // AND-mode counts are already absolute and pass through untouched.
    const asResultingTotal = (counts: Record<string, number>): Record<string, number> =>
      shiftFacets
        ? Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v + currentTotal]))
        : counts

    // Custom-field options are selectable values like any other, so each field's
    // map shifts too (myBillsCount/newMatchesCount/unvotedCount below do NOT —
    // they describe the current result rather than naming a value you can pick).
    for (const fieldId of Object.keys(customFields)) {
      customFields[fieldId] = asResultingTotal(customFields[fieldId])
    }

    // Build dimensional facet count maps
    // Each *Counts map is built from raw per-value numbers (deltas under
    // match=any), any derived sentinel is summed from those, and asResultingTotal
    // shifts the finished map exactly once at the end.
    const statusCounts = asResultingTotal(countsOf(statusRows))
    const stageCounts = asResultingTotal(countsOf(stageRows))
    const sessionCounts = asResultingTotal(countsOf(sessionRows))
    const yearCounts = asResultingTotal(countsOf(yearRows, v => v !== null && v !== undefined))
    const stateCounts = asResultingTotal(countsOf(stateRows))
    // A team field has no value for a group that never had one: "none" is the groups the facet's filter meets
    // less those with a current value, and "any" is those with one (each group has one holder).
    const sum = (rows: CountRow[]) => rows.reduce((a, r) => a + r.n, 0)
    const priorityCounts: Record<string, number> = countsOf(priorityRows)
    priorityCounts['none'] = (await groupsMeeting('priority')) - sum(priorityRows)
    priorityCounts[FILTER_ANY] = sum(priorityRows)
    const priorityCountsOut = asResultingTotal(priorityCounts)
    const positionCounts: Record<string, number> = countsOf(positionRows)
    positionCounts['none'] = (await groupsMeeting('position')) - sum(positionRows)
    positionCounts[FILTER_ANY] = sum(positionRows)
    const positionCountsOut = asResultingTotal(positionCounts)
    const tagCounts: Record<string, number> = Object.fromEntries(
      tagRows.filter(r => tagSet.has(String(r.values[0]))).map(r => [String(r.values[0]), r.n]),
    )
    // "Any tag" = groups whose current analysis has at least one VALID (in-taxonomy) tag (within the tag facet's scope).
    tagCounts[FILTER_ANY] = anyTagRows[0]?.n ?? 0
    const tagCountsOut = asResultingTotal(tagCounts)

    const subjectCounts: Record<string, number> = asResultingTotal(Object.fromEntries(
      subjectRows
        .filter(r => !isSubjectsSuppressedForState(suppressedSubjectStates, String(r.values[0])))
        .map(r => [encodeSubjectFilter(String(r.values[0]), String(r.values[1])), r.n]),
    ))

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
      customFields,
      myBillsCount,
      newMatchesCount,
      unvotedCount,
      draftCount,
      hasDrafts,
    })
  })
}
