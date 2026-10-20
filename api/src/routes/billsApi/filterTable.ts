import { eq, and, or, inArray, sql, SQL } from 'drizzle-orm'
import { customFieldDefinitions } from '../../db/schema'
import type { AppDb } from '../../types'
import {
  billsAs, buildCustomFieldFilters, buildSearchCondition, filterSuppressedSubjects, hasGroupTags, loadMyBillsInGroups,
  committeeMembership, multiFilter, myBillsCondition, positionCondition, priorityCondition, statusFilterValues, subjectMembership, tagCondition,
  unvotedCondition, type BillFilterContext, type BillsCondition, type BillsFilter,
} from './query'
import { countBy, countHolders, freshOf, type Counting, type CountRow } from './facetCounts'
import { countGroups } from './groupList'
import { FILTER_ANY, FILTER_NONE, type BillFilter } from '../../../../shared/billFilter'
import { stagePosition, type StatusStage } from '../../../../shared/statusStages'
import { loadSuppressedSubjectStates, isSubjectsSuppressedForState, encodeSubjectFilter } from '../../lib/billSubjects'
import { loadTaxonomyTagNameSet } from '../../lib/taxonomy'
import { newMatchWhere } from '../../lib/newMatch'
import { holdsGroupPriority, holdsGroupValue } from '../../lib/teamFields'
import { loadVotedInGroups } from '../../lib/companionGroups'

/**
 * The API's table of filters: one entry for each filter the shared bill filter names (`shared/billFilter.ts`),
 * holding the filter's SQL condition and its facet count. The table is typed against the shared names, so a
 * filter with no entry, or an entry with no condition or no `facet`, does not compile. Everything else on the
 * API that has to know every filter reads it from here:
 *
 * - the list's filter (`buildBillsFilter`) and the facets' filters (`buildFilterParts`), from the conditions
 * - each facet's own-filter exclusion, which is the entry's own name, never a string typed beside the count
 * - the facets response, and the empty one for a list with nothing in it (`facetsResponse`, `emptyFacets`)
 *
 * (The list cache's key is the serialized bill filter, `lib/listCache.ts`, and needs nothing from the table.)
 *
 * The entries are in the order their conditions join the filter, so the SQL a request builds is the same as
 * it was when each condition was written out in `buildFilterParts`.
 */

// ── Conditions ──────────────────────────────────────────────────────────

/** What a condition may read besides its filter's value: the database, what the route read for the request, and the whole filter. */
export type ConditionContext = BillFilterContext & { db: AppDb; filter: BillFilter }

/** What a condition reads when the request can match nothing, whatever else it sets. */
export const NO_MATCH = Symbol('no match')

/** A condition's result: the condition on one bill, or undefined when the filter's value adds none. */
type Built = BillsCondition | undefined

/**
 * How an entry's condition joins the others:
 * - `fact`: a fact about the bill, which the group operator joins. A fact that names `joins` is not a fact of
 *   its own: its condition is ORed into the named filter's, so the two are one fact (the stage joins the status,
 *   #677) with one key, which every facet leaves out whole
 * - `custom-field`: one fact for each custom field with a value, keyed by the field's id
 * - `scope`: viewer-relative or search, which always narrows
 * - `operator`: no condition of its own: it says how the facts join
 * - `modifier`: no condition of its own: it says how another filter reads (the committee scope), and sets that part
 */
type Condition<V> =
  | { kind: 'fact'; joins?: keyof BillFilter; condition: (value: V, ctx: ConditionContext) => Built | Promise<Built> }
  | { kind: 'custom-field'; condition: (value: V, ctx: ConditionContext) => Promise<Record<string, BillsCondition>> }
  | { kind: 'scope'; condition: (value: V, ctx: ConditionContext) => Built | typeof NO_MATCH | Promise<Built | typeof NO_MATCH> }
  | { kind: 'operator'; condition: (value: V) => 'all' | 'any' }
  | { kind: 'modifier'; condition: (value: V) => Partial<Pick<FilterParts, 'committeeScope'>> }

// ── Facet counts ────────────────────────────────────────────────────────

/** A facet count's value, by the kind of count it is. */
type Counts = Record<string, number>

/**
 * What a facet count reads: the request's filters, with the means to count under them. A count is run with
 * the entry's own name, and counts with that filter left out, which is what makes a facet disjunctive
 * (`counting`).
 */
export type FacetContext = {
  db: AppDb
  userId: string
  isAdmin: boolean
  /** How the bill facts combine, the filter's `match`. */
  match: BillFilter['match']
  /** Whether the committee facet counts current committees or any referral (`FilterParts.committeeScope`). */
  committeeScope: BillFilter['committeeScope']
  /** The committees the filter picks (`FilterParts.committeesPicked`), which `committeeInfo` always names. */
  committeesPicked: BillFilter['committee']
  /** Whether the tenant has any draft, unfiltered. */
  hasDrafts: boolean
  newMatchMinRelevance: number
  /** The member's bills, in their groups (`loadMyBillsInGroups`). */
  mine: readonly string[]
  suppressedSubjectStates: ReadonlySet<string>
  /** The keys of the facts the request filters by (`FilterParts.facts`). */
  factKeys: readonly string[]
  /** The list's filter in full, the result the counts beside the facets are counted within. */
  currentOnM: SQL | undefined
  /** The facet's filter: every filter but the ones named, the group operator's way (see `makeFacetContext`). */
  counting: (...omit: string[]) => Counting
  /** The count of all groups a facet's filter meets (priority and position name the groups with no value by it). */
  groupsMeeting: (own: string) => Promise<number>
  /** A map of counts as the facet shows it: under OR, each value's resulting total instead of its own. */
  shift: (counts: Counts) => Promise<Counts>
}

/**
 * A facet count, by the kind of facet it is:
 * - `values`: the groups with each value of the filter, as a map from value to count
 * - `custom-fields`: that, for each custom field
 * - `count`: the groups of the current result with a bill of the kind the filter names, one number
 * A facet of values has the filter's own name as its key in the facets response, as in the URL (`tag`, `subject`,
 * `sessionName`, `field`). A count names its own key (`unvotedCount`), since it counts bills, not a filter's values.
 * `empty` is the value it has when nothing matches. `count` is called with the key of the entry's own fact
 * (its name, or the filter it joins), which is what it leaves out.
 * A `derived` facet is read from a filter's own rows and has a key of its own (`statusGroups`), not a count of the
 * filter's values.
 */
type Facet<R> = {
  empty: () => R
  count: (fc: FacetContext, own: string) => Promise<R>
} & ({ kind: 'values' | 'custom-fields' } | { kind: 'count' | 'derived'; response: string })

// ── The table ───────────────────────────────────────────────────────────

type Entry<V> = Condition<V> & {
  /** The filter's facet count, or null for a filter with none (nothing offers its values as options). */
  facet: Facet<unknown> | null
  /** Further facets read from the filter's rows, each with a key of its own in the facets response. */
  alsoFacets?: Array<Facet<unknown> & { kind: 'derived' }>
}

export type FilterTable = { [K in keyof BillFilter]: Entry<BillFilter[K]> }

const m = billsAs('m')
const me = billsAs('me')

const both = (a: SQL | undefined, b: SQL): SQL => (a ? and(a, b)! : b)
const countsOf = (rows: CountRow[], keep: (value: unknown) => boolean = Boolean): Counts =>
  Object.fromEntries(rows.filter(r => keep(r.values[0])).map(r => [String(r.values[0]), r.n]))
const sum = (rows: CountRow[]) => rows.reduce((a, r) => a + r.n, 0)

/** A facet of the groups with each value of a column of the bill, counted by the bills' own values (status, stage, year, session, state). */
const billColumn = (column: SQL, keep?: (value: unknown) => boolean): Facet<Counts> => ({
  kind: 'values',
  empty: () => ({}),
  count: async (fc, own) => fc.shift(countsOf(await countBy(fc.db, fc.counting(own), { values: [column], from: sql`bills m` }), keep)),
})

/**
 * Each status label with bills, with the stage its bills sit in and the rank they sort by (`statusGroups`). It is read
 * from the rows the status counts are, the facets' filter with the whole status fact left out, so the page can list a
 * label under its stage's heading. A label whose bills sit in more than one stage (rows written before provider
 * vocabularies) takes the stage with the most bills and, in a tie, the later stage. Bills with no stage count for a
 * stage only when none of the label's bills has one. Its rank is the highest among the label's bills.
 *
 * It tallies bills where the counts beside it tally groups, since which stage holds most of a label's bills is a
 * question about bills, and it is no count of what a pick would total. It reads each bill's rank, which no index
 * carries, so it runs as one statement of its own, never as a column of the status count that the group key
 * index answers alone.
 */
const statusGroups: Facet<Record<string, { stage: string | null; rank: number }>> & { kind: 'derived' } = {
  kind: 'derived',
  response: 'statusGroups',
  empty: () => ({}),
  count: async (fc, own) => {
    const where = fc.counting(own).where(m)
    const rows = await fc.db.all(sql`SELECT ${m.status} AS label, ${m.statusStage} AS stage, MAX(${m.statusRank}) AS rank, SUM(1) AS bills
      FROM bills m${where ? sql` WHERE ${where}` : sql``} GROUP BY ${m.status}, ${m.statusStage}`) as Array<{ label: string; stage: string | null; rank: number; bills: number }>
    const byLabel = new Map<string, typeof rows>()
    for (const r of rows) if (r.label) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r])
    return Object.fromEntries([...byLabel].map(([label, group]) => {
      const staged = group.filter(r => r.stage)
      const best = [...(staged.length > 0 ? staged : group)].sort((a, b) =>
        Number(b.bills) - Number(a.bills) || stagePosition(b.stage as StatusStage) - stagePosition(a.stage as StatusStage))[0]
      return [label, { stage: best.stage ?? null, rank: Math.max(...group.map(r => Number(r.rank))) }]
    }))
  },
}

/** The rows the committee facet reads (#471): each bill's committees, or only its current one under the current scope. */
const committeeRows = sql`bill_committees bc JOIN bills m ON m.id = bc.bill_id`
const currentOnly = (fc: FacetContext) => fc.committeeScope === 'current' ? sql`bc.is_current = 1` : undefined

/**
 * Each committee counted, with its name, state, and chamber (`committeeInfo`), which the menu labels and groups the
 * counts by. Read from the rows the committee counts are, and from every row of a committee the filter picks, whatever
 * the scope and the other filters, so a picked committee they leave out can still be shown picked and named on its chip. A committee central renamed keeps its old name on a bill
 * until the bill's next delivery, so the name is the greatest of the names its bills hold.
 */
const committeeInfo: Facet<Record<string, { name: string; state: string; chamber: string | null }>> & { kind: 'derived' } = {
  kind: 'derived',
  response: 'committeeInfo',
  empty: () => ({}),
  count: async (fc, own) => {
    const where = fc.counting(own).where(m)
    const current = currentOnly(fc)
    const conditions = [where, current].filter((c): c is SQL => c !== undefined)
    const counted = conditions.length > 0 ? and(...conditions)! : undefined
    const picked = fc.committeesPicked.length > 0 ? sql`bc.committee_id IN (SELECT value FROM json_each(${JSON.stringify(fc.committeesPicked)}))` : undefined
    // With no condition on the counts every committee is named, the picked ones among them.
    const named = counted && picked ? or(counted, picked)! : counted
    const rows = await fc.db.all(sql`SELECT bc.committee_id AS id, MAX(bc.name) AS name, MAX(bc.state) AS state, MAX(bc.chamber) AS chamber
      FROM ${committeeRows}${named ? sql` WHERE ${named}` : sql``} GROUP BY bc.committee_id`) as Array<{ id: string; name: string; state: string; chamber: string | null }>
    return Object.fromEntries(rows.map(r => [r.id, { name: r.name, state: r.state, chamber: r.chamber || null }]))
  },
}

/** A count of the groups of the current result with a bill of one kind. */
const currentCount = (response: string, count: (fc: FacetContext) => Promise<number>): Facet<number> => ({
  kind: 'count', response, empty: () => 0, count: fc => count(fc),
})

export const FILTER_TABLE: FilterTable = {
  status: {
    kind: 'fact',
    condition: values => {
      const statuses = statusFilterValues(values)
      return statuses.length > 0 ? t => multiFilter(t.status, statuses)! : undefined
    },
    facet: billColumn(sql`${m.status}`),
    alsoFacets: [statusGroups],
  },
  // The stage is a way of choosing statuses (a heading selects the whole stage), so its condition is part of the
  // status fact (#677): a bill meets it when its status is chosen or its stage is. Both facets leave the whole fact out.
  stage: {
    kind: 'fact',
    joins: 'status',
    condition: values => values.length > 0 ? t => multiFilter(t.statusStage, values)! : undefined,
    facet: billColumn(sql`${m.statusStage}`),
  },
  // Priority is sparse (bills can have none): "Any" = has a priority, "none" = no priority.
  priority: {
    kind: 'fact',
    condition: values => priorityCondition(values),
    // The team's own fields are the group's current value, held by one bill: a group counts under that bill's value.
    facet: {
      kind: 'values',
      empty: () => ({ [FILTER_NONE]: 0, [FILTER_ANY]: 0 }),
      count: async (fc, own) => {
        const rows = await countHolders(fc.db, fc.counting(own), {
          values: [sql`${me.priority}`], from: sql`bills me`, holds: sql`${me.priority} IN ('high', 'medium', 'low') AND ${holdsGroupPriority(me)}`,
        })
        // A team field has no value for a group that never had one: "none" is the groups the facet's filter meets
        // less those with a current value, and "any" is those with one (each group has one holder).
        const counts: Counts = countsOf(rows)
        counts[FILTER_NONE] = (await fc.groupsMeeting(own)) - sum(rows)
        counts[FILTER_ANY] = sum(rows)
        return fc.shift(counts)
      },
    },
  },
  sessionName: {
    kind: 'fact',
    condition: values => values.length > 0 ? t => multiFilter(t.session, values)! : undefined,
    facet: billColumn(sql`${m.session}`),
  },
  year: {
    kind: 'fact',
    condition: values => values.length > 0
      ? t => values.length === 1 ? eq(t.yearStart, Number(values[0])) : inArray(t.yearStart, values.map(Number))
      : undefined,
    facet: billColumn(sql`${m.yearStart}`, v => v !== null && v !== undefined),
  },
  state: {
    kind: 'fact',
    condition: values => values.length > 0 ? t => multiFilter(t.state, values)! : undefined,
    facet: billColumn(sql`${m.state}`),
  },
  search: {
    kind: 'scope',
    condition: search => search && buildSearchCondition(search) ? t => buildSearchCondition(search, t)! : undefined,
    facet: null,
  },
  minRelevance: {
    kind: 'fact',
    condition: min => min !== null ? t => sql`${t.relevanceScore} >= ${min}` : undefined,
    facet: null,
  },
  // One condition per custom field; each is a bill fact, so each joins the group operator.
  field: {
    kind: 'custom-field',
    condition: (field, ctx) => buildCustomFieldFilters(ctx.db, field),
    facet: { kind: 'custom-fields', empty: () => ({}), count: customFieldCounts },
  },
  // The taxonomy is read only for "any tag", the one value that depends on it.
  tag: {
    kind: 'fact',
    condition: async (tags, ctx) => tagCondition(tags, tags.includes(FILTER_ANY) ? await loadTaxonomyTagNameSet(ctx.db) : new Set()),
    facet: {
      kind: 'values',
      empty: () => ({ [FILTER_ANY]: 0 }),
      count: async (fc, own) => {
        const tagSet = await loadTaxonomyTagNameSet(fc.db)
        // "Any tag" = a valid (in-taxonomy) tag: the list filter's own condition, so the two cannot drift.
        const anyTagCond = tagCondition([FILTER_ANY], tagSet)!
        const [tagRows, anyTagRows] = await Promise.all([
          // Every bill of a group has the group's current tags as its group tags, so tags count as a fact about each
          // bill does, starting from the few bills that have any.
          countBy(fc.db, fc.counting(own), { values: [sql`jt.value`], from: sql`bills m, json_each(${m.groupTags}) jt`, where: hasGroupTags(m) }),
          countBy(fc.db, fc.counting(own), { values: [], from: sql`bills m`, where: anyTagCond(m) }),
        ])
        const counts: Counts = Object.fromEntries(tagRows.filter(r => tagSet.has(String(r.values[0]))).map(r => [String(r.values[0]), r.n]))
        // "Any tag" = groups whose current analysis has at least one VALID (in-taxonomy) tag (within the tag facet's scope).
        counts[FILTER_ANY] = anyTagRows[0]?.n ?? 0
        return fc.shift(counts)
      },
    },
  },
  subject: {
    kind: 'fact',
    condition: async (subjects, ctx) => {
      if (subjects.length === 0) return undefined
      const allowed = filterSuppressedSubjects(subjects, await loadSuppressedSubjectStates(ctx.db))
      return allowed.length > 0 ? t => subjectMembership(allowed, t) : undefined
    },
    facet: {
      kind: 'values',
      empty: () => ({}),
      count: async (fc, own) => {
        const rows = await countBy(fc.db, fc.counting(own), { values: [sql`bs.state`, sql`bs.subject_name`], from: sql`bill_subjects bs JOIN bills m ON m.id = bs.bill_id` })
        return fc.shift(Object.fromEntries(
          rows
            .filter(r => !isSubjectsSuppressedForState(fc.suppressedSubjectStates, String(r.values[0])))
            .map(r => [encodeSubjectFilter(String(r.values[0]), String(r.values[1])), r.n]),
        ))
      },
    },
  },
  // A committee is a fact about the bill: one it was referred to, or under the current scope the one it is pending in.
  committee: {
    kind: 'fact',
    condition: (ids, ctx) => ids.length > 0 ? t => committeeMembership(ids, ctx.filter.committeeScope, t) : undefined,
    facet: {
      kind: 'values',
      empty: () => ({}),
      count: async (fc, own) => fc.shift(countsOf(await countBy(fc.db, fc.counting(own), {
        values: [sql`bc.committee_id`], from: committeeRows, where: currentOnly(fc),
      }))),
    },
    alsoFacets: [committeeInfo],
  },
  committeeScope: {
    kind: 'modifier',
    condition: committeeScope => ({ committeeScope }),
    facet: null,
  },
  position: {
    kind: 'fact',
    condition: values => positionCondition(values),
    facet: {
      kind: 'values',
      empty: () => ({ [FILTER_NONE]: 0, [FILTER_ANY]: 0 }),
      count: async (fc, own) => {
        const rows = await countHolders(fc.db, fc.counting(own), {
          values: [sql`p.position`], from: sql`official_positions p CROSS JOIN bills me ON me.id = p.bill_id`, holds: holdsGroupValue('official_positions'),
        })
        const counts: Counts = countsOf(rows)
        counts[FILTER_NONE] = (await fc.groupsMeeting(own)) - sum(rows)
        counts[FILTER_ANY] = sum(rows)
        return fc.shift(counts)
      },
    },
  },
  // A member's votes are the group's: unvoted means no vote on any bill in it. One JSON parameter of the bills to leave out.
  unvoted: {
    kind: 'scope',
    condition: async (on, ctx) => on ? unvotedCondition(await loadVotedInGroups(ctx.db, ctx.userId)) : undefined,
    facet: currentCount('unvotedCount', async fc =>
      countGroups(fc.db, both(fc.currentOnM, unvotedCondition(await loadVotedInGroups(fc.db, fc.userId))(m)))),
  },
  newMatches: {
    kind: 'scope',
    condition: (on, ctx) => on ? t => newMatchWhere(ctx.newMatchMinRelevance, t) : undefined,
    facet: currentCount('newMatchesCount', async fc =>
      fc.isAdmin ? countGroups(fc.db, both(fc.currentOnM, newMatchWhere(fc.newMatchMinRelevance, m)), true) : 0),
  },
  drafts: {
    kind: 'scope',
    condition: on => on ? t => eq(t.isDraft, true) : undefined,
    // Most tenants have no drafts, where a count read through the draft index would still read the table (it holds one value).
    facet: currentCount('draftCount', async fc => fc.hasDrafts ? countGroups(fc.db, both(fc.currentOnM, eq(m.isDraft, true))) : 0),
  },
  myBills: {
    kind: 'scope',
    condition: async (on, ctx) => {
      if (!on) return undefined
      // A member's engagement is with the group, as unvoted's votes are: a group is mine when any bill of it is.
      const myIds = ctx.myBillIds ?? await loadMyBillsInGroups(ctx.db, ctx.userId)
      // Scope, not a bill fact: an empty set means no rows regardless of the group operator.
      return myIds.length === 0 ? NO_MATCH : myBillsCondition(myIds)
    },
    facet: currentCount('myBillsCount', async fc =>
      fc.mine.length > 0 ? countGroups(fc.db, both(fc.currentOnM, myBillsCondition(fc.mine)(m)), true) : 0),
  },
  match: {
    kind: 'operator',
    condition: match => match,
    facet: null,
  },
}

// ── Custom-field counts ─────────────────────────────────────────────────

/** The key of a custom field's fact in `FilterParts.facts`. */
export const customFieldFactKey = (fieldId: string) => `field.${fieldId}`
const CUSTOM_FIELD_FACT_PREFIX = customFieldFactKey('')

/**
 * Custom fields. Multi-select fields store their value as a JSON array, so their option counts must json_each-expand
 * it (same as the tag facet) instead of grouping by the raw array string. Single-value fields group by the raw value.
 * Each field with an active filter of its own is counted with that filter left out (disjunctive), and the fields
 * with none share one count.
 */
async function customFieldCounts(fc: FacetContext): Promise<Record<string, Counts>> {
  const { db } = fc
  const cfDefs = await db.select({ id: customFieldDefinitions.id, multiple: customFieldDefinitions.multiple }).from(customFieldDefinitions).all()
  const multiIds = new Set(cfDefs.filter(d => d.multiple).map(d => d.id))
  const cfFieldIds = fc.factKeys.filter(k => k.startsWith(CUSTOM_FIELD_FACT_PREFIX)).map(k => k.slice(CUSTOM_FIELD_FACT_PREFIX.length))

  // An active `field.` param that resolves to no real field (deleted field, garbled
  // key — see query.ts's `__unresolved_cf__` sentinel) still lands in the filter as
  // a condition that matches zero bills. It is not a real facet dimension, so it
  // must never be allowed to narrow (i.e. zero out) any OTHER field's facet filter
  // — only its own now-defunct "facet" would ever legitimately exclude it, and
  // nothing queries that. Excluding it explicitly, everywhere its exclusion
  // matters, keeps a stale saved view from blanking every custom-field dropdown.
  const validCfFieldIdSet = new Set(cfDefs.map(d => d.id))
  const unresolvedCfFieldIds = cfFieldIds.filter(id => !validCfFieldIdSet.has(id))
  const idList = (ids: string[]) => sql.join(ids.map(id => sql`${id}`), sql`, `)
  const cfOmit = (...ids: string[]) => ids.map(customFieldFactKey)

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

  // Fields with no active filter share one count, and leaving the filtered ones out of its output, not the merge
  // order, keeps their own counts from being overwritten by ones that include their own filter. Separately,
  // leaving unresolvedCfFieldIds out of the filter keeps a stale/garbled field. key from zeroing every real field's count.
  if (cfFieldIds.length === 0) {
    mergeCfRows(await cfCounts(fc.counting()))
  } else {
    const perField = await Promise.all(cfFieldIds.map(id => cfCounts(fc.counting(...cfOmit(id, ...unresolvedCfFieldIds)), id)))
    for (const rows of perField) mergeCfRows(rows)
    mergeCfRows(await cfCounts(fc.counting(...cfOmit(...unresolvedCfFieldIds)), undefined, cfFieldIds))
  }

  // Custom-field options are selectable values like any other, so each field's map shifts too (the counts beside the
  // facets do NOT: they describe the current result rather than naming a value you can pick).
  for (const fieldId of Object.keys(customFields)) customFields[fieldId] = await fc.shift(customFields[fieldId])
  return customFields
}

// ── The list's filter, built from the table ────────────────────────────

/**
 * The parts of the list's filters, each a condition on one bill, before they are
 * joined into one filter (`composeFilter`). The facets count a dimension with
 * that dimension's own part left out, so they take the parts by name.
 */
export type FilterParts = {
  /** The bill facts, which the group operator joins: each filter's name (`field.<field id>` for a custom field) and its condition. */
  facts: Array<{ key: string; condition: BillsCondition }>
  /** The viewer-relative predicates and search, which always narrow. */
  scopes: BillsCondition[]
  /** "My bills" was asked for by a member with none, so nothing matches whatever else is set. */
  noMatch: boolean
  /** How the facts join: all of them, or any one (the filter's `match`). */
  match: BillFilter['match']
  /** How the committee filter and its facet read a bill's committees (the filter's `committeeScope`). */
  committeeScope: BillFilter['committeeScope']
  /** The committees the filter picks, which the facets always name. */
  committeesPicked: BillFilter['committee']
}

const NAMES = Object.keys(FILTER_TABLE) as Array<keyof BillFilter>

/** The key of the fact a filter's condition belongs to: its own name, or the filter it joins. */
export const factKeyOf = (name: keyof BillFilter): string => {
  const entry = FILTER_TABLE[name] as Entry<unknown>
  return entry.kind === 'fact' && entry.joins ? entry.joins : name
}

/** A fact's condition, ORed into the fact of the same key when a filter that joins it has already added one. */
function addFact(parts: FilterParts, key: string, condition: BillsCondition) {
  const existing = parts.facts.find(f => f.key === key)
  if (!existing) { parts.facts.push({ key, condition }); return }
  const joined = existing.condition
  existing.condition = t => or(joined(t), condition(t))!
}

/**
 * The list's filters as parts, each a condition on the bill it tests. Filter
 * predicates stay per bill: the bill list asks of each bill in a companion
 * group whether it meets the filter and shows the group if any does (see
 * groupList.ts), and the team's own fields are read through the group's
 * current value (query.ts).
 *
 * Bill facts render as chip-row groups and are joined by the group operator.
 * Scope conditions (the viewer-relative predicates and search) always
 * AND on top: `(fact1 OP fact2 OP … ) AND search AND myBills AND unvoted …`.
 * See docs/superpowers/specs/2026-09-07-filter-group-operator-design.md.
 */
export async function buildFilterParts(db: AppDb, f: BillFilter, ctx: BillFilterContext): Promise<FilterParts> {
  const parts: FilterParts = { facts: [], scopes: [], noMatch: false, match: 'all', committeeScope: 'any', committeesPicked: f.committee }
  const context: ConditionContext = { ...ctx, db, filter: f }
  for (const name of NAMES) {
    // One entry's condition reads its own filter's value, which the table's type pairs with it.
    const entry = FILTER_TABLE[name] as Entry<unknown>
    const value = f[name]
    switch (entry.kind) {
      case 'fact': {
        const condition = await entry.condition(value, context)
        if (condition) addFact(parts, entry.joins ?? name, condition)
        break
      }
      case 'custom-field':
        for (const [fieldId, condition] of Object.entries(await entry.condition(value, context))) {
          parts.facts.push({ key: customFieldFactKey(fieldId), condition })
        }
        break
      case 'scope': {
        const condition = await entry.condition(value, context)
        if (condition === NO_MATCH) parts.noMatch = true
        else if (condition) parts.scopes.push(condition)
        break
      }
      case 'operator':
        parts.match = entry.condition(value) === 'any' ? 'any' : 'all'
        break
      case 'modifier':
        Object.assign(parts, entry.condition(value))
        break
    }
  }
  return parts
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
        : (parts.match === 'any' ? or(...facts)! : and(...facts)!)

    const all = [...(factCond ? [factCond] : []), ...parts.scopes.map(f => f(t))]
    if (all.length === 0) return undefined
    return all.length === 1 ? all[0] : and(...all)!
  }
}

/** The list's filters as a function of the bill they test, built once and applied to as many references to `bills` as a query needs. */
export async function buildBillsFilter(db: AppDb, f: BillFilter, ctx: BillFilterContext): Promise<BillsFilter> {
  return composeFilter(await buildFilterParts(db, f, ctx))
}

// ── The facets, built from the table ───────────────────────────────────

/** What a facets request needs to build its counts. */
export type FacetRequest = Pick<FacetContext, 'db' | 'userId' | 'isAdmin' | 'hasDrafts' | 'newMatchMinRelevance' | 'mine' | 'suppressedSubjectStates'> & {
  parts: FilterParts
}

/**
 * The context the facets' counts run in. A facet counts what the list will total if you pick a value, so it
 * counts under the list's filters with its own left out (disjunctive faceting: dropping a term from an AND
 * widens the set). Under OR (match=any) that logic inverts: a value's marginal contribution to an OR is
 * independent of the other groups, so dropping just one term still narrows the count to bills matching every
 * OTHER active filter, which is wrong (the tag facet must not be scoped down to the subject-matching bills
 * only). So under match=any every facet counts over the scopes alone, with no bill fact at all, each filter
 * evaluated independently of the others.
 *
 * Under match=any a facet count is the RESULTING TOTAL, what the list will show if you pick this value, which is
 * what AND mode's disjunctive faceting has always meant. Counting the value's whole population instead made one
 * label answer a different question in each mode, and the arithmetic visibly failed for operators (see the
 * 2026-09-07 spec).
 *
 *   resultingTotal(v) = currentTotal + |{v} ∩ scope ∩ NOT currentResult|
 *
 * The delta is shared across filters: under OR, adding v yields currentResult ∪ {v} whichever filter v came
 * from, so there is no own-filter term to exclude. It counts GROUPS, so a group a different bill of which is
 * already in the current result is not added again: `fresh` is true of a bill of a group none of whose bills is
 * in it. It is a conditional count rather than a WHERE term on purpose: filtering the rows by NOT current would
 * drop a value whose bills are ALL already showing out of the GROUP BY entirely, so it would vanish from the
 * dropdown instead of reading "picking this changes nothing".
 */
export function makeFacetContext(req: FacetRequest): FacetContext {
  const { db, parts } = req
  const any = parts.match === 'any'
  // The list's filter in full: the current result, which the counts beside the facets and an OR facet's resulting total are counted within.
  const current = composeFilter(parts)
  const currentOnM = current(m)
  // Whether any bill-fact filter is actually set. The OR identity only holds when there is an existing OR to add
  // a value to: with nothing selected, picking a value NARROWS the list rather than widening it, so counts stay
  // absolute (which is also exactly what AND mode does).
  const shiftFacets = any && parts.facts.length > 0
  const fresh = shiftFacets ? freshOf(current) : undefined
  const scopesOnly = composeFilter(parts, { facts: false })
  const counting = (...omit: string[]): Counting => ({ where: any ? scopesOnly : composeFilter(parts, { omit: new Set(omit) }), fresh })

  // The list's total is only queried at all when shiftFacets is active: under AND mode (or with no bill-fact
  // filter active) the shift is the identity and the value would be thrown away.
  const currentTotal = shiftFacets ? countGroups(db, currentOnM) : Promise.resolve(0)
  currentTotal.catch(() => undefined)

  // Under AND the dimension's own fact is left out, so a dimension that is not filtered shares one count with the others.
  const totals = new Map<string, Promise<number>>()
  const groupsMeeting = (own: string) => {
    const key = !any && parts.facts.some(f => f.key === own) ? own : ''
    if (!totals.has(key)) totals.set(key, countBy(db, counting(own), { values: [], from: sql`bills m` }).then(rows => rows[0].n))
    return totals.get(key)!
  }

  return {
    db, userId: req.userId, isAdmin: req.isAdmin, match: parts.match, committeeScope: parts.committeeScope, committeesPicked: parts.committeesPicked, hasDrafts: req.hasDrafts, newMatchMinRelevance: req.newMatchMinRelevance,
    mine: req.mine, suppressedSubjectStates: req.suppressedSubjectStates,
    factKeys: parts.facts.map(f => f.key), currentOnM, counting, groupsMeeting,
    shift: async counts => {
      if (!shiftFacets) return counts
      const total = await currentTotal
      return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v + total]))
    },
  }
}

/** The filters that have a facet count, each with the name that is its own-filter exclusion. */
const FACETS = NAMES.flatMap(name => {
  const entry = FILTER_TABLE[name]
  // The fact a facet leaves out is the filter's own, or the one it joins: the status and the stage leave out the same one.
  const own = factKeyOf(name)
  return [...(entry.facet ? [entry.facet] : []), ...(entry.alsoFacets ?? [])].map(facet => (
    { name: own, key: facet.kind === 'count' || facet.kind === 'derived' ? facet.response : name, facet }
  ))
})

/** Every facet's count, in parallel, by the key each has in the facets response. */
export async function countFacets(fc: FacetContext): Promise<Record<string, unknown>> {
  return Object.fromEntries(await Promise.all(FACETS.map(async ({ name, key, facet }) => [key, await facet.count(fc, name)] as const)))
}

/** What the facets response holds besides the counts of the filters: the tenant's own values, which no filter narrows. */
export type TenantFacets = {
  /** The states with subjects, unfiltered (per bill). */
  subjectStates: string[]
  /** On `*` coverage, the states with bills; absent on an explicit list. */
  billStates?: string[]
  /** Whether the tenant has any draft at all, unfiltered. */
  hasDrafts: boolean
}

export const facetsResponse = (counts: Record<string, unknown>, tenant: TenantFacets) =>
  ({ ...counts, subjectStates: tenant.subjectStates, billStates: tenant.billStates, hasDrafts: tenant.hasDrafts })

/** The response for a list with nothing in it: the real response's every key, every count at zero. Built from the same table. */
export const emptyFacets = (tenant: TenantFacets) =>
  facetsResponse(Object.fromEntries(FACETS.map(({ key, facet }) => [key, facet.empty()])), tenant)
