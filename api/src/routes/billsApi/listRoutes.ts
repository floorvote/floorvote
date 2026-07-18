import { Hono } from 'hono'
import { eq, and, or, like, inArray, sql, ne, isNull, isNotNull, SQL } from 'drizzle-orm'
import { getDb } from '../../db/client'
import {
  bills, memberVotes, officialPositions, comments, notes, users, billCustomFieldValues, customFieldDefinitions,
} from '../../db/schema'
import type { AppEnv } from '../../types'
import { sessionToSlug } from '../../lib/sessionSlug'
import { buildBillsWhere, buildOrderBy, multiFilter, buildSearchCondition, newMatchWhere, FILTER_ANY, canOptimize } from './query'
import { getNewMatchMinRelevance } from '../../lib/newMatch'
import { cacheKeyFor, getCachedPage, putCachedPage, listCacheTtl, isPerUserListRequest } from '../../lib/listCache'
import type { CachedListPage } from '../../lib/listCache'
import { activeUser } from '../../lib/accountDeletion'

export function registerListRoutes(router: Hono<AppEnv>) {
  // GET /bills — list with optional filters and server-side pagination
  router.get('/', async (c) => {
    const db = getDb(c.env.DB)
    const {
      sort, dir: dirParam, minRelevance,
      myBills: myBillsParam, unvoted, newMatches: newMatchesParam,
      page: pageParam, pageSize: pageSizeParam,
    } = c.req.query()
    const statuses = c.req.queries('status') ?? []
    const priorities = c.req.queries('priority') ?? []
    const positionValues = c.req.queries('position') ?? []
    const sessions = c.req.queries('session') ?? []
    const years = c.req.queries('year') ?? []
    const states = c.req.queries('state') ?? []
    const tagFilters = c.req.queries('tag') ?? []
    const q = c.req.query('q')
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

    const finalWhere = await buildBillsWhere(db, {
      statuses,
      priorities,
      positionValues,
      sessions,
      years,
      states,
      tagFilters,
      q,
      minRelevance,
      myBillsParam: myBillsParam === '1' || myBillsParam === 'true' ? '1' : undefined,
      unvoted,
      newMatches: newMatchesActive ? '1' : undefined,
      newMatchMinRelevance,
      cfParamMap,
      userId: currentUser.id,
    })

    // Sort
    const orderByClauses = buildOrderBy(sort ?? 'default', sortDir)

    // ── Default-list query cache ──────────────────────────────────────────
    // The count+ordered-page query is the expensive, SHARED part (full scan +
    // filesort, identical for all users). Cache only that `{ total, billRows }`
    // pair. Per-user filters (myBills/unvoted) make the bill SET user-specific,
    // so they bypass the cache entirely and always run fresh.
    // newMatches is org-shared but admin-only and low-volume; skip the shared page
    // cache rather than widen the cache key for it.
    const cacheable = !isPerUserListRequest({ myBills: myBillsParam, unvoted }) && !newMatchesActive
    const ttl = listCacheTtl(c.env)
    const cacheKey = cacheable
      ? cacheKeyFor(c.env, {
          statuses, priorities, positionValues, sessions, years, states, tagFilters,
          q, minRelevance, cfParamMap, sort: sort ?? 'default', dir: sortDir, page, pageSize,
        })
      : null

    type BillRow = typeof bills.$inferSelect
    let total: number
    let billRows: BillRow[]

    const cached = cacheKey && ttl > 0 ? await getCachedPage(c.env, cacheKey) : null
    if (cached) {
      total = cached.total
      billRows = cached.billRows as unknown as BillRow[]
    } else {
      const sortCol = sort ?? 'default'
      const optimize = canOptimize(sortCol, sortDir)

      // Phase 1: counts — always get total; get trackedCount when optimizing
      const totalPromise = db.select({ total: sql<number>`count(*)` }).from(bills).where(finalWhere).all()
      const trackedPromise = optimize
        ? db.select({ total: sql<number>`count(*)` }).from(bills)
            .where(finalWhere ? and(isNotNull(bills.matchType), finalWhere) : isNotNull(bills.matchType)).all()
        : null
      const [totalResult, trackedResult] = await Promise.all([totalPromise, trackedPromise])
      total = totalResult[0].total
      const trackedCount = trackedResult ? trackedResult[0].total : 0

      // Phase 2: data query — fast path or normal path
      const useFastPath = optimize
        && trackedCount > 0
        && !(q && trackedCount < pageSize)
        && (offset + pageSize <= trackedCount)

      if (useFastPath) {
        const trackedWhere = finalWhere
          ? and(isNotNull(bills.matchType), finalWhere)
          : isNotNull(bills.matchType)
        billRows = await db.select().from(bills)
          .where(trackedWhere)
          .orderBy(...orderByClauses)
          .limit(pageSize).offset(offset).all()
      } else {
        billRows = await db.select().from(bills)
          .where(finalWhere)
          .orderBy(...orderByClauses)
          .limit(pageSize).offset(offset).all()
      }

      if (cacheKey && ttl > 0) {
        const payload: CachedListPage = { total, billRows: billRows as unknown as Record<string, unknown>[] }
        await putCachedPage(c.env, cacheKey, payload, ttl)
      }
    }

    if (billRows.length === 0) {
      return c.json({ bills: [], pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } })
    }

    const billIds = billRows.map(b => b.id)

    // Scoped metadata queries — only for current page
    const [[voteCountRows, positionRows, commentCountRows, myVoteRows, myNoteRows, myCommentRows], cfValueRows] = await Promise.all([
      Promise.all([
      db.select({
        billId: memberVotes.billId,
        support: sql<number>`COUNT(CASE WHEN ${memberVotes.position} = 'support' THEN 1 END)`,
        oppose: sql<number>`COUNT(CASE WHEN ${memberVotes.position} = 'oppose' THEN 1 END)`,
        neutral: sql<number>`COUNT(CASE WHEN ${memberVotes.position} = 'neutral' THEN 1 END)`,
      }).from(memberVotes)
        .innerJoin(users, eq(memberVotes.userId, users.id))
        // D1 limits bound params to 100 per statement. canVote uses a SQL literal (not a bound param) to stay within budget.
        .where(and(inArray(memberVotes.billId, billIds), sql`${users.canVote} = 1`, activeUser))
        .groupBy(memberVotes.billId).all(),
      db.select({ billId: officialPositions.billId, position: officialPositions.position })
        .from(officialPositions).where(inArray(officialPositions.billId, billIds)).all(),
      db.select({ billId: comments.billId, count: sql<number>`COUNT(*)` })
        .from(comments)
        .innerJoin(users, eq(comments.userId, users.id))
        .where(and(inArray(comments.billId, billIds), isNull(comments.deletedAt), activeUser))
        .groupBy(comments.billId).all(),
      // Per-user queries: omit billIds filter (user data is small; extra rows are harmless since we only look up by current page's bill IDs)
      db.select({ billId: memberVotes.billId, position: memberVotes.position })
        .from(memberVotes).where(eq(memberVotes.userId, currentUser.id)).all(),
      db.select({ billId: notes.billId })
        .from(notes).where(and(eq(notes.userId, currentUser.id), ne(notes.content, ''))).all(),
      db.select({ billId: comments.billId })
        .from(comments).where(and(eq(comments.userId, currentUser.id), isNull(comments.deletedAt))).all(),
      ]),
      db.select({ billId: billCustomFieldValues.billId, fieldId: billCustomFieldValues.fieldId, value: billCustomFieldValues.value })
        .from(billCustomFieldValues).where(inArray(billCustomFieldValues.billId, billIds)).all(),
    ])

    const cfByBill = new Map<string, Record<string, string>>()
    for (const row of cfValueRows) {
      if (!cfByBill.has(row.billId)) cfByBill.set(row.billId, {})
      cfByBill.get(row.billId)![row.fieldId] = row.value
    }

    const votesByBill = new Map(voteCountRows.map(r => [r.billId, { support: r.support, oppose: r.oppose, neutral: r.neutral }]))
    const positionByBill = new Map(positionRows.map(r => [r.billId, r.position]))
    const commentCountByBill = new Map(commentCountRows.map(r => [r.billId, Number(r.count)]))
    const myVoteByBill = new Map(myVoteRows.map(r => [r.billId, r.position]))
    const myNoteBillIds = new Set(myNoteRows.map(r => r.billId))
    const myCommentBillIds = new Set(myCommentRows.map(r => r.billId))

    const result = billRows.map(b => ({
      id: b.id,
      billNumber: b.billNumber,
      title: b.title,
      state: b.state,
      status: b.status,
      session: b.session,
      sessionSlug: sessionToSlug(b.session),
      sessionId: b.sessionId,
      yearStart: b.yearStart ?? null,
      yearEnd:   b.yearEnd   ?? null,
      abstract: b.abstract,
      url: b.url,
      stateUrl: b.stateUrl,
      lastAction: b.lastAction,
      lastActionDate: b.lastActionDate,
      tenantSummary: b.tenantSummary,
      tags: JSON.parse(b.tags) as string[],
      priority: b.priority,
      sponsor: b.sponsor,
      sponsorParty: b.sponsorParty,
      stateLink: b.stateLink,
      matchType: b.matchType,
      isDraft: b.isDraft,
      addedBy: b.addedBy,
      relevanceScore: b.relevanceScore,
      aiProcessedAt: b.aiProcessedAt,
      newMatchAt: b.newMatchAt,
      triagedAt: b.triagedAt,
      lastAiTextDocId: b.lastAiTextDocId,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      position: positionByBill.get(b.id) ?? null,
      voteCounts: votesByBill.get(b.id) ?? { support: 0, oppose: 0, neutral: 0 },
      commentCount: commentCountByBill.get(b.id) ?? 0,
      myVote: myVoteByBill.get(b.id) ?? null,
      hasNote: myNoteBillIds.has(b.id),
      hasComment: myCommentBillIds.has(b.id),
      customFieldValues: cfByBill.get(b.id) ?? {},
    }))

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
    const priorities = c.req.queries('priority') ?? []
    const positionValues = c.req.queries('position') ?? []
    const sessions = c.req.queries('session') ?? []
    const years = c.req.queries('year') ?? []
    const states = c.req.queries('state') ?? []
    const tagFilters = c.req.queries('tag') ?? []
    const q = c.req.query('q')
    const minRelevance = c.req.query('minRelevance')
    const myBillsParam = c.req.query('myBills')
    const unvoted = c.req.query('unvoted')
    const newMatchesParam = c.req.query('newMatches')
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
    const statusFilter = multiFilter(bills.status, statuses)
    let priorityFilter: SQL | undefined
    if (priorities.length > 0) {
      const hasAny = priorities.includes(FILTER_ANY)
      const hasNone = priorities.includes('none')
      const real = priorities.filter(v => v !== FILTER_ANY && v !== 'none') as ('high' | 'medium' | 'low')[]
      const parts: SQL[] = []
      if (real.length > 0) parts.push(real.length === 1 ? eq(bills.priority, real[0]) : inArray(bills.priority, real))
      if (hasAny) parts.push(isNotNull(bills.priority))
      if (hasNone) parts.push(isNull(bills.priority))
      if (parts.length > 0) priorityFilter = parts.length === 1 ? parts[0] : or(...parts)!
    }
    const sessionFilter = multiFilter(bills.session, sessions)
    const yearFilter = years.length > 0
      ? (years.length === 1
          ? eq(bills.yearStart, Number(years[0]))
          : inArray(bills.yearStart, years.map(Number)))
      : undefined
    const stateFilter = multiFilter(bills.state, states)

    let tagFilter: SQL | undefined
    {
      const hasAnyTag = tagFilters.includes(FILTER_ANY)
      const realTags = tagFilters.filter(t => t !== FILTER_ANY)
      const parts: SQL[] = []
      if (hasAnyTag) parts.push(sql`json_array_length(${bills.tags}) > 0`)
      if (realTags.length === 1) parts.push(like(bills.tags, `%"${realTags[0]}"%`))
      else if (realTags.length > 1) parts.push(or(...realTags.map(tag => like(bills.tags, `%"${tag}"%`)))!)
      if (parts.length > 0) tagFilter = parts.length === 1 ? parts[0] : or(...parts)!
    }

    let positionFilter: SQL | undefined
    if (positionValues.length > 0) {
      const hasNone = positionValues.includes('none')
      const hasAny = positionValues.includes(FILTER_ANY)
      const realPositions = positionValues.filter(p => p !== 'none' && p !== FILTER_ANY)
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
      if (parts.length > 0) positionFilter = parts.length === 1 ? parts[0] : or(...parts)!
    }

    // --- Base conditions (non-dimensional, apply to all facet queries) ---
    const baseConditions: SQL[] = []

    if (q) {
      const searchCond = buildSearchCondition(q)
      if (searchCond) baseConditions.push(searchCond)
    }
    if (minRelevance) baseConditions.push(sql`${bills.relevanceScore} >= ${parseInt(minRelevance, 10)}`)

    // CF conditions tracked separately so each field can be excluded for its own facet counts
    const cfSqlMap: Record<string, SQL> = {}
    for (const [fieldId, values] of Object.entries(cfParamMap)) {
      const realValues = values.filter(v => v !== FILTER_ANY)
      const parts: SQL[] = []
      if (values.includes(FILTER_ANY)) {
        parts.push(sql`${bills.id} IN (SELECT bill_id FROM bill_custom_field_values WHERE field_id = ${fieldId})`)
      }
      if (realValues.length > 0) {
        parts.push(inArray(bills.id,
          db.select({ billId: billCustomFieldValues.billId }).from(billCustomFieldValues)
            .where(and(eq(billCustomFieldValues.fieldId, fieldId),
              realValues.length === 1 ? eq(billCustomFieldValues.value, realValues[0]) : inArray(billCustomFieldValues.value, realValues)
            ))
        ))
      }
      if (parts.length > 0) cfSqlMap[fieldId] = parts.length === 1 ? parts[0] : or(...parts)!
    }

    if (myBillsParam === 'true' || myBillsParam === '1') {
      const [voteRows, noteRows, commentRows] = await Promise.all([
        db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, currentUser.id)).all(),
        db.select({ billId: notes.billId }).from(notes).where(and(eq(notes.userId, currentUser.id), ne(notes.content, ''))).all(),
        db.select({ billId: comments.billId }).from(comments).where(and(eq(comments.userId, currentUser.id), isNull(comments.deletedAt))).all(),
      ])
      const ids = [...new Set([...voteRows, ...noteRows, ...commentRows].map(r => r.billId))]
      if (ids.length > 0) baseConditions.push(inArray(bills.id, ids))
      else return c.json({ status: {}, priority: {}, year: {}, session: {}, state: {}, position: { none: 0 }, tags: {}, customFields: {}, myBillsCount: 0, newMatchesCount: 0 })
    }

    if (unvoted === '1') {
      baseConditions.push(sql`${bills.id} NOT IN (SELECT bill_id FROM member_votes WHERE user_id = ${currentUser.id})`)
    }

    // When the worklist filter is active, every dimensional facet respects it too
    // (mirrors how myBills/unvoted scope the facets above).
    if (newMatchesActive) baseConditions.push(newMatchWhere(newMatchMinRelevance))

    // Disjunctive: each dimension's WHERE omits that dimension's own filter
    // excludeCfFieldId omits that CF field's condition (for CF disjunctive counts)
    function buildWhere(excludeCfFieldId?: string, ...dimFilters: (SQL | undefined)[]): SQL | undefined {
      const cfParts = Object.entries(cfSqlMap)
        .filter(([id]) => id !== excludeCfFieldId)
        .map(([, s]) => s)
      const all = [...baseConditions, ...cfParts, ...dimFilters.filter(Boolean) as SQL[]]
      return all.length > 0 ? and(...all) : undefined
    }

    const statusWhere   = buildWhere(undefined, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter)
    const priorityWhere = buildWhere(undefined, statusFilter,   yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter)
    const yearWhere     = buildWhere(undefined, statusFilter,   priorityFilter, sessionFilter, stateFilter, tagFilter, positionFilter)
    const stateWhere    = buildWhere(undefined, statusFilter,   priorityFilter, yearFilter, sessionFilter, tagFilter, positionFilter)
    const positionWhere = buildWhere(undefined, statusFilter,   priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter)
    const tagWhere      = buildWhere(undefined, statusFilter,   priorityFilter, yearFilter, sessionFilter, stateFilter, positionFilter)
    // Full WHERE (all filters) for myBillsCount
    const finalWhere    = buildWhere(undefined, statusFilter,   priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter)

    const tagWhereClause = tagWhere ? sql`WHERE ${tagWhere}` : sql``

    // Run all dimensional facet queries in parallel
    const [statusRows, priorityRows, sessionRows, yearRows, stateRows, setPositionRows, tagRows, myInteractionRows, noPositionCountRows] = await Promise.all([
      db.select({ value: bills.status, count: sql<number>`COUNT(*)` })
        .from(bills).where(statusWhere).groupBy(bills.status).all(),
      db.select({ value: bills.priority, count: sql<number>`COUNT(*)` })
        .from(bills).where(priorityWhere).groupBy(bills.priority).all(),
      db.select({ value: bills.session, count: sql<number>`COUNT(*)` })
        .from(bills).where(yearWhere).groupBy(bills.session).all(),
      db.select({ value: bills.yearStart, count: sql<number>`COUNT(*)` })
        .from(bills).where(yearWhere).groupBy(bills.yearStart).all(),
      db.select({ value: bills.state, count: sql<number>`COUNT(*)` })
        .from(bills).where(stateWhere).groupBy(bills.state).all(),
      db.select({ value: officialPositions.position, count: sql<number>`COUNT(*)` })
        .from(officialPositions)
        .innerJoin(bills, eq(officialPositions.billId, bills.id))
        .where(positionWhere)
        .groupBy(officialPositions.position).all(),
      db.all(sql`SELECT jt.value as tag, COUNT(*) as cnt FROM bills, json_each(bills.tags) jt ${tagWhereClause} GROUP BY jt.value`) as Promise<{ tag: string; cnt: number }[]>,
      Promise.all([
        db.select({ billId: memberVotes.billId }).from(memberVotes).where(eq(memberVotes.userId, currentUser.id)).all(),
        db.select({ billId: notes.billId }).from(notes).where(and(eq(notes.userId, currentUser.id), ne(notes.content, ''))).all(),
        db.select({ billId: comments.billId }).from(comments).where(and(eq(comments.userId, currentUser.id), isNull(comments.deletedAt))).all(),
      ]),
      db.select({ noPositionCount: sql<number>`COUNT(*)` })
        .from(bills)
        .where(positionWhere
          ? and(positionWhere, sql`${bills.id} NOT IN (SELECT bill_id FROM official_positions)`)
          : sql`${bills.id} NOT IN (SELECT bill_id FROM official_positions)`)
        .all(),
    ])

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
    const cfCounts = async (where: SQL | undefined, restrictFieldId?: string): Promise<CfRow[]> => {
      const out: CfRow[] = []
      const restrictIsMulti = restrictFieldId ? multiIds.has(restrictFieldId) : undefined
      if (!restrictFieldId || restrictIsMulti === false) {
        const extra: (SQL | undefined)[] = [where]
        if (restrictFieldId) extra.push(sql`bcfv.field_id = ${restrictFieldId}`)
        else if (multiIds.size) extra.push(sql`bcfv.field_id NOT IN (${idList([...multiIds])})`)
        out.push(...await db.all(sql`SELECT bcfv.field_id AS field_id, bcfv.value AS opt, COUNT(*) AS cnt FROM bill_custom_field_values bcfv INNER JOIN bills ON bills.id = bcfv.bill_id ${whereOf(extra)} GROUP BY bcfv.field_id, bcfv.value`) as CfRow[])
      }
      if ((!restrictFieldId && multiIds.size > 0) || restrictIsMulti === true) {
        const idCond = restrictFieldId ? sql`field_id = ${restrictFieldId}` : sql`field_id IN (${idList([...multiIds])})`
        out.push(...await db.all(sql`SELECT bcfv.field_id AS field_id, je.value AS opt, COUNT(*) AS cnt FROM (SELECT bill_id, field_id, value FROM bill_custom_field_values WHERE ${idCond} AND json_valid(value) = 1) bcfv INNER JOIN bills ON bills.id = bcfv.bill_id INNER JOIN json_each(bcfv.value) je ${whereOf([where])} GROUP BY bcfv.field_id, je.value`) as CfRow[])
      }
      // "Any" = distinct bills with any value for the field (honest count for the top row).
      const anyExtra: (SQL | undefined)[] = [where]
      if (restrictFieldId) anyExtra.push(sql`bcfv.field_id = ${restrictFieldId}`)
      out.push(...await db.all(sql`SELECT bcfv.field_id AS field_id, ${FILTER_ANY} AS opt, COUNT(DISTINCT bcfv.bill_id) AS cnt FROM bill_custom_field_values bcfv INNER JOIN bills ON bills.id = bcfv.bill_id ${whereOf(anyExtra)} GROUP BY bcfv.field_id`) as CfRow[])
      return out
    }

    if (cfFieldIds.length === 0) {
      mergeCfRows(await cfCounts(finalWhere))
    } else {
      // Per active field, count with that field's own filter excluded (disjunctive).
      const perFieldResults = await Promise.all(
        cfFieldIds.map(id => cfCounts(buildWhere(id, statusFilter, priorityFilter, yearFilter, sessionFilter, stateFilter, tagFilter, positionFilter), id))
      )
      for (const rows of perFieldResults) mergeCfRows(rows)
    }

    // Build dimensional facet count maps
    const statusCounts = Object.fromEntries(statusRows.filter(r => r.value).map(r => [r.value!, Number(r.count)]))
    const priorityCounts: Record<string, number> = Object.fromEntries(priorityRows.filter(r => r.value).map(r => [r.value!, Number(r.count)]))
    // Priority is sparse: "Not set" = null priority; "Any" = has a priority.
    priorityCounts['none'] = Number(priorityRows.find(r => r.value == null)?.count ?? 0)
    priorityCounts[FILTER_ANY] = (priorityCounts['high'] ?? 0) + (priorityCounts['medium'] ?? 0) + (priorityCounts['low'] ?? 0)
    const sessionCounts = Object.fromEntries(sessionRows.filter(r => r.value).map(r => [r.value!, Number(r.count)]))
    const yearCounts = Object.fromEntries(
      yearRows.filter(r => r.value != null).map(r => [String(r.value!), Number(r.count)])
    )
    const stateCounts = Object.fromEntries(stateRows.filter(r => r.value).map(r => [r.value!, Number(r.count)]))
    const positionCounts: Record<string, number> = Object.fromEntries(setPositionRows.map(r => [r.value, Number(r.count)]))
    positionCounts['none'] = Number(noPositionCountRows[0].noPositionCount)
    // "Any position" = bills with any position set (one position per bill, so summing is safe).
    positionCounts[FILTER_ANY] = setPositionRows.reduce((a, r) => a + Number(r.count), 0)
    const tagCounts: Record<string, number> = Object.fromEntries(tagRows.map(r => [r.tag, Number(r.cnt)]))
    // "Any tag" = distinct bills with at least one tag (within the tag facet's scope).
    const hasTagCond = sql`json_array_length(${bills.tags}) > 0`
    const [anyTagRow] = await db.select({ cnt: sql<number>`count(*)` }).from(bills)
      .where(tagWhere ? and(tagWhere, hasTagCond) : hasTagCond).all()
    tagCounts[FILTER_ANY] = Number(anyTagRow?.cnt ?? 0)

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

    return c.json({
      status: statusCounts,
      priority: priorityCounts,
      year: yearCounts,
      session: sessionCounts,
      state: stateCounts,
      position: positionCounts,
      tags: tagCounts,
      customFields,
      myBillsCount,
      newMatchesCount,
    })
  })
}
