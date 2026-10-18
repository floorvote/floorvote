import { Hono } from 'hono'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { bills, billSubjects } from '../../db/schema'
import type { AppEnv } from '../../types'
import { billsAs, isCheapFilter, loadMyBillsInGroups, canOptimize } from './query'
import { buildBillsFilter, buildFilterParts, countFacets, emptyFacets, facetsResponse, makeFacetContext } from './filterTable'
import { billStatesForWildcard } from '../../lib/billStates'
import { getNewMatchMinRelevance } from '../../lib/newMatch'
import { loadTaxonomyTagNameSet } from '../../lib/taxonomy'
import { cacheKeyFor, getCachedPage, putCachedPage, listCacheTtl, isPerUserListRequest } from '../../lib/listCache'
import type { CachedListPage } from '../../lib/listCache'
import { countGroups, loadGroupRows, pageOfGroups, trackedBills, type PageOptions } from './groupList'
import { loadSuppressedSubjectStates, isSubjectsSuppressedForState } from '../../lib/billSubjects'
import { parseBillFilter } from '../../../../shared/billFilter'
import { subjectCapError } from './filterRequest'

export function registerListRoutes(router: Hono<AppEnv>) {
  // GET /bills — the list, one row per companion group, with optional filters and server-side pagination
  router.get('/', async (c) => {
    const db = getDb(c.env.DB)
    const bf = parseBillFilter(new URL(c.req.url).searchParams)
    const capError = subjectCapError(bf)
    if (capError) return c.json(capError, 400)
    const { sort, dir: dirParam, page: pageParam, pageSize: pageSizeParam } = c.req.query()
    const search = bf.search || undefined
    const sortDir = dirParam === 'asc' ? 'asc' : 'desc' as const

    const page = Math.max(1, parseInt(pageParam ?? '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeParam ?? '50', 10) || 50))
    const offset = (page - 1) * pageSize
    const currentUser = c.get('user')

    const newMatchMinRelevance = bf.newMatches ? await getNewMatchMinRelevance(db) : 0

    // A group matches when any bill in it does, so the filter stays a condition
    // on one bill, applied to whichever bill a query is testing (groupList.ts).
    const filter = await buildBillsFilter(db, bf, { userId: currentUser.id, newMatchMinRelevance })
    const filtered = filter(billsAs('m'))
    const hasFilter = filtered !== undefined
    // A filter is held twice in a statement when that leaves room under D1's 100 bound parameters, which lets the
    // tracked-first path test a bill with no companions directly. A cheap filter that fits twice also gets the full path's two-part form.
    const twice = hasFilter && new SQLiteSyncDialect().sqlToQuery(filtered).params.length * 2 <= 90
    const cheapFilter = twice && isCheapFilter(bf)

    // ── Default-list query cache ──────────────────────────────────────────
    // The count+ordered-page query is the expensive, SHARED part (full scan +
    // filesort, identical for all users). Cache only that `{ total, billRows }`
    // pair, where billRows names the groups on the page. Per-user filters
    // (myBills/unvoted) make the bill SET user-specific, so they bypass the
    // cache entirely and always run fresh.
    // The key is the whole bill filter (lib/listCache.ts), so a filter that changes the bill set can't be left out of it.
    // newMatches is the triage worklist: it changes as bills are triaged, and is low-volume, so it skips the shared page cache.
    const cacheable = !isPerUserListRequest(bf) && !bf.newMatches
    const ttl = listCacheTtl(c.env)
    const cacheKey = cacheable
      ? cacheKeyFor(c.env, { filter: bf, sort: sort ?? 'default', dir: sortDir, page, pageSize })
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
      // regardless, so the fast path buys little here; bypass it whenever search is set.
      const optimize = canOptimize(sortCol, sortDir) && !search

      // ── Pagination fast path via matchType ────────────────────────────────
      // A group counts as tracked if any bill in it is. total counts every group
      // that meets the filter, tracked or not. trackedCount is: "how many tracked
      // bills sort ahead of the rest" (a count of bills, which groupList.ts says
      // gates the fast path without being the number of tracked groups). Misreading
      // it as a scope filter produces wrong conclusions about the visible set.
      // Phase 1: counts — always get total; get the tracked count when optimizing
      const [totalGroups, trackedCount] = await Promise.all([
        countGroups(db, filtered, bf.newMatches || bf.drafts || bf.myBills),
        optimize ? trackedBills(db, filtered) : 0,
      ])
      total = totalGroups

      // Phase 2: the page of groups — fast path or normal path. The tracked-first
      // page is only good when it fills: tracked groups that reach this far make a
      // full page of the list's first groups, and a short page means they don't.
      const sortArgs: Omit<PageOptions, 'tracked'> = { filter: hasFilter ? filter : undefined, twice, cheapFilter, col: sortCol, dir: sortDir, search, limit: pageSize, offset }
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

    const bf = parseBillFilter(new URL(c.req.url).searchParams)
    const capError = subjectCapError(bf)
    if (capError) return c.json(capError, 400)
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'owner'
    // Threshold is only needed for the admin count or when the worklist filter is active.
    // The member's bills are read once for the request: the my bills scope (when it is on) and the count beside the
    // facets both use them, alongside the threshold's read.
    const [newMatchMinRelevance, mine] = await Promise.all([
      (isAdmin || bf.newMatches) ? getNewMatchMinRelevance(db) : Promise.resolve(0),
      loadMyBillsInGroups(db, currentUser.id),
    ])

    // The facets' filters are the list's own, built once in query.ts, so the two can't drift: each is a
    // condition on one bill, and a companion group meets it when a bill of it does (facetCounts.ts).
    // Bill facts join by the group operator, and the scopes (search, my bills, unvoted, new matches,
    // drafts) always narrow. A dimension's facet leaves its own fact out.
    const parts = await buildFilterParts(db, bf, { userId: currentUser.id, newMatchMinRelevance, myBillIds: mine })

    // hasDrafts: does this TENANT have any draft at all, completely unfiltered
    // — no dimensional filters, no myBills/unvoted/newMatches scope. This is
    // the chip-visibility signal (draftCount below stays filtered, for the
    // badge). Computed up front so the myBills early-return below — which
    // otherwise skips straight to an empty facets object — still reports it
    // correctly instead of hard-coding false. The 1 is written in the SQL, not bound: SQLite serves
    // the probe from the partial index of drafts (0107) only when it sees is_draft = 1 in the
    // statement, and without it the planner scans the table (#551). billsFacetsPlan.test.ts pins
    // the plan.
    const [hasDraftRow] = await db.select({ id: bills.id })
      .from(bills)
      .where(sql`${bills.isDraft} = 1`)
      .limit(1)
      .all()
    const hasDrafts = hasDraftRow !== undefined

    // Loaded unconditionally (not just when a `subject` param is present): the
    // subjects facet's own counts must omit suppressed states even with no
    // active subject filter, and a suppressed value in the filter must not
    // narrow the other dimensions' counts either (see filterSuppressedSubjects).
    const suppressedSubjectStates = await loadSuppressedSubjectStates(db)

    // Which states have subjects at all, with no filter applied (a state-leading
    // index makes this a cheap skip-scan). The `subjects` facet below is scoped
    // by the other active filters, so it can't tell the web app "this state has
    // none" from "a filter hid it". Suppressed states count as having none.
    // Counted per bill, not per companion group: a state is in the list when
    // any bill there has subjects, whichever bill stands for its group's row.
    const subjectStates = (await db.selectDistinct({ state: billSubjects.state }).from(billSubjects).all())
      .map(r => r.state)
      .filter(st => !isSubjectsSuppressedForState(suppressedSubjectStates, st))
      .sort()
    // Every state the instance has bills in, for `*` coverage; absent on an
    // explicit list, and cached per tenant (lib/billStates.ts). Per bill too.
    const billStates = await billStatesForWildcard(db, c.env.TENANT_ID, c.env.STATE)

    const tenant = { subjectStates, billStates, hasDrafts }
    // "My bills" for a member with none matches nothing. The response is the real one's, built from the same table with every count at zero.
    if (parts.noMatch) return c.json(emptyFacets(tenant))

    // Every filter's count, from the table (filterTable.ts): each leaves its own filter out, and the rest narrow it.
    const counts = await countFacets(makeFacetContext({
      db, parts, userId: currentUser.id, isAdmin, hasDrafts, newMatchMinRelevance, mine, suppressedSubjectStates,
    }))
    return c.json(facetsResponse(counts, tenant))
  })
}
