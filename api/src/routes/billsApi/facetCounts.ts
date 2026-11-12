import { and, sql, type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import type { AppDb } from '../../types'
import type { BillsTable } from '../../lib/teamFields'
import { billsAs, type BillsFilter } from './query'

/**
 * Counting groups for the facets (see **Companion group** in CONTEXT.md).
 *
 * A facet counts what the list will total if you pick a value, and the list
 * counts companion groups, so a facet counts each group once however many of
 * its bills qualify. The filters are conditions on one bill (query.ts), and a
 * group is counted when some bill of it meets the facet's filter, as in the
 * list. Two kinds of facet differ in how the group gets its value:
 *
 * - A fact about each bill (status, stage, state, session, year, subject): a
 *   group counts under every value one of its qualifying bills has. These are
 *   counted as before groups, then corrected for the grouped bills: the
 *   whole-population count less the grouped bills plus their distinct groups,
 *   which the group key index (0102) answers without reading the table
 *   (`countBy`). The five bill columns are counted that way from one cube a
 *   request rather than a statement each (`countCube`). Tags count this way too: every bill stores its group's
 *   current tags as its group tags (migration 0103), so all bills of a group
 *   have the same ones.
 * - A team field (priority, position, custom fields): the group has one
 *   current value, held by one bill (teamFields.ts), so a group counts under
 *   that bill's value, once, if some bill of it qualifies (`countHolders`). A
 *   value a newer one on a companion replaced is not counted.
 *
 * Under OR a facet counts the resulting total: the current groups plus those
 * the value would add, which are groups none of whose bills is in the current
 * result (`fresh`, below).
 */

const m = billsAs('m') // a bill the facet's filter tests
const me = billsAs('me') // the bill holding a team field value

/** What a facet counts: the bills it counts through, and, under OR, only those of groups not already in the result. */
export type Counting = {
  /** The facet's filter on a bill, undefined for every bill. */
  where: BillsFilter
  /** Under OR: the groups to count are those with no bill in the current result. */
  fresh: Fresh | undefined
  /**
   * Under OR, when the current result is small: the freshness test built from the keys of the result, read once a
   * request (`freshOfKeys`), which a statement uses in place of `fresh` so that none tests every bill against the
   * filter again. Undefined once the result is too big to hold, and then `fresh` is the test.
   */
  freshKeys?: () => Promise<Fresh | undefined>
  /** Whether the bills `where` meets are most of the table, so that counting the ones it leaves out reads fewer rows. */
  broad?: () => Promise<boolean>
  /**
   * Whether any group has two bills holding one subject (a row in `group_subjects`, migration 0126), asked once a request.
   * When none does, the subject count needs no correction for groups.
   */
  groupsShareSubjects?: () => Promise<boolean>
}

/**
 * How a count reads a broad filter, and how large a result it holds as keys. Tests set them to run each form.
 * - `complement`: `auto` counts the rows of the bills a filter leaves out when most bills meet it, and subtracts them from
 *   the rows of the table, which the subject and committee indexes answer whole. `always` and `never` force a form.
 * - `keysMax`: the most keys (bills in no group, and groups) of the current result a request holds under match=any, bound
 *   to a statement as JSON. 0 turns the form off. 5,000 keys of UUIDs are about 190 KB, under D1's limit on a bound value.
 */
export const countStrategy: { complement: 'auto' | 'always' | 'never'; keysMax: number } = { complement: 'auto', keysMax: 5000 }

/** The current result under match=any, as the bills in no group it holds and the groups it holds, each once. */
export type CurrentKeys = { ids: string[]; groups: string[] }

/**
 * The bills of the current result as keys, read once a request: its ungrouped bills' ids and its groups' keys. Undefined
 * when there are more than `countStrategy.keysMax`, and the counts test each bill against the filter instead.
 */
export async function loadCurrentKeys(db: AppDb, current: SQL | undefined): Promise<CurrentKeys | undefined> {
  const max = countStrategy.keysMax
  if (max <= 0 || !current) return undefined
  const rows = await db.all(sql`SELECT m.id AS id, m.group_key AS gk FROM bills m WHERE ${current} LIMIT ${max + 1}`) as Array<{ id: string; gk: string | null }>
  if (rows.length > max) return undefined
  return { ids: rows.filter(r => r.gk === null).map(r => r.id), groups: [...new Set(rows.filter(r => r.gk !== null).map(r => r.gk as string))] }
}

/** True of a bill in no group of the result keys (`CurrentKeys`), as `freshOf`'s is of the filter, built from them. */
export function freshOfKeys(keys: CurrentKeys): Fresh {
  const ids = JSON.stringify(keys.ids)
  const groups = JSON.stringify(keys.groups)
  return {
    test: t => sql`CASE WHEN ${t.groupKey} IS NULL THEN ${t.id} NOT IN (SELECT value FROM json_each(${ids}))
      ELSE ${t.groupKey} NOT IN (SELECT value FROM json_each(${groups})) END`,
  }
}

/**
 * What a statement that counts only groups none of whose bills is in the current result needs: `test` is true
 * of a bill of such a group, and `cte`, when there is one, starts the statement.
 */
export type Fresh = { cte?: SQL; test: (t: BillsTable) => SQL }

/** A group's bills' values of the columns counted, and the number of groups. */
export type CountRow = { values: unknown[]; n: number; /** The `extras` of the read, when the whole count read them (`countBy`). */ extra?: unknown[] }

/**
 * The most values the current filter may bind for a statement to hold it twice (`freshOf`). The per-bill form
 * binds 2V + S values for a filter of V, where the scopes S are part of V (so S < V), and the custom field id
 * lists a statement adds come on top, so 25 keeps it under D1's 100. A test sets it to 0 to run the list form.
 */
export const freshForm = { perBillMax: 25 }

/**
 * True for a bill in no group meeting the current result, and for a bill of a
 * group none of whose bills meets it. A bill with no companions is tested by
 * the current filter itself, and a grouped bill by a list of the groups in the
 * result, built once for the statement. That holds the filter's values twice in
 * a statement, which D1's 100 bound values allow a small filter. A larger one
 * (a broad OR selection) is read once into a list of every bill in the result
 * instead, named by its id or its group key, which costs a list of every such
 * bill per statement and so is only used where the first would fail.
 */
export function freshOf(current: BillsFilter): Fresh {
  const cm = billsAs('cm')
  const values = new SQLiteSyncDialect().sqlToQuery(current(billsAs('probe'))!).params.length
  if (values > freshForm.perBillMax) {
    return {
      cte: sql`cur AS MATERIALIZED (SELECT ${cm.id} AS id, ${cm.groupKey} AS gk FROM bills cm WHERE ${current(cm)})`,
      test: t => sql`CASE WHEN ${t.groupKey} IS NULL THEN ${t.id} NOT IN (SELECT id FROM cur)
        ELSE ${t.groupKey} NOT IN (SELECT gk FROM cur WHERE gk IS NOT NULL) END`,
    }
  }
  return {
    test: t => sql`CASE WHEN ${t.groupKey} IS NULL THEN COALESCE((${current(t)}), 0) = 0
      ELSE ${t.groupKey} NOT IN (SELECT cm.group_key FROM bills cm WHERE cm.group_key IS NOT NULL AND ${current(cm)}) END`,
  }
}

/** `WITH` the statement's common tables, or nothing when it has none. */
const withCtes = (ctes: Array<SQL | undefined>) => {
  const used = ctes.filter((c): c is SQL => c !== undefined)
  return used.length > 0 ? sql`WITH ${sql.join(used, sql`, `)} ` : sql``
}

const valueColumns = (values: SQL[]) => values.map((v, i) => sql`${v} AS ${sql.raw(`v${i}`)}`)
const valueNames = (values: SQL[]) => values.map((_, i) => sql.raw(`v${i}`))
const groupBy = (terms: SQL[]) => (terms.length > 0 ? sql` GROUP BY ${sql.join(terms, sql`, `)}` : sql``)
const countOf = (fresh: SQL | undefined) => (fresh ? sql`COALESCE(SUM(CASE WHEN ${fresh} THEN 1 ELSE 0 END), 0)` : sql`COUNT(*)`)
const keyOf = (row: Record<string, unknown>, n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => row[`v${i}`]))
const valuesOf = (row: Record<string, unknown>, n: number) => Array.from({ length: n }, (_, i) => row[`v${i}`])

/**
 * The grouped correction of the subject count, read from the subjects the groups share (`group_subjects`, 0126) in place
 * of the subject rows of every grouped bill. A group counts once under a subject however many of its bills that meet the
 * filter hold it, so the correction to a subject's count of bills is, for each group, the number of its bills holding the
 * subject that meet the filter, less one. The rows come back as `bills` (that sum) and `groups` of 0, which the count takes
 * from the whole count as it takes the statement it replaces.
 *
 * `qual` is the grouped bills that meet the filter (and, under OR, are fresh), the filter evaluated once. A group with
 * every bill in `qual` has its correction summed from the table, a seek in its primary key for each, as every bill of
 * it holds the subjects the table counts. A group with a bill the filter leaves out has only some of its bills counted, so
 * its correction is counted from the subject rows of the bills in `qual`, which the table cannot say. Those are the few
 * groups a filter splits, and the rows read are theirs alone.
 */
function sharedSubjectCorrection(db: AppDb, freshCte: SQL | undefined, w: SQL | undefined, fresh: SQL | undefined): Promise<Record<string, unknown>[]> {
  const conditions = [sql`${m.groupKey} IS NOT NULL`, w, fresh ? sql`(${fresh})` : undefined].filter((c): c is SQL => c !== undefined)
  const ctes = withCtes([
    freshCte,
    sql`qual AS MATERIALIZED (SELECT ${m.id} AS id, ${m.groupKey} AS gk FROM bills m WHERE ${sql.join(conditions, sql` AND `)})`,
    sql`kept AS MATERIALIZED (SELECT gk, COUNT(*) AS q, (SELECT COUNT(*) FROM bills a WHERE a.group_key = qual.gk) AS size FROM qual GROUP BY gk)`,
  ])
  return db.all(sql`${ctes}SELECT v0, v1, COALESCE(SUM(c), 0) AS bills, 0 AS groups FROM (
    SELECT gs.state AS v0, gs.subject_name AS v1, gs.n - 1 AS c FROM kept k CROSS JOIN group_subjects gs ON gs.group_key = k.gk WHERE k.q = k.size
    UNION ALL
    SELECT s AS v0, j AS v1, c - 1 AS c FROM (SELECT bs.state AS s, bs.subject_name AS j, COUNT(*) AS c FROM kept p CROSS JOIN qual q ON q.gk = p.gk CROSS JOIN bill_subjects bs ON bs.bill_id = q.id
      WHERE p.q < p.size GROUP BY q.gk, bs.state, bs.subject_name HAVING COUNT(*) > 1)) GROUP BY v0, v1`) as Promise<Record<string, unknown>[]>
}

/**
 * Groups by the values of `values` over `from` (which names the bill `m`), each
 * counted once: the bills as before groups, less the grouped bills, plus their
 * groups. The grouped bills are read through the group key index, in its order
 * (the group key first), so a group's bills are met together and no group is
 * counted by a set of its own. With no values, one row counts all groups.
 * `where`, when given, is a further condition of the facet rather than of the
 * filter, on `m` (the tag facets count only bills with group tags) or on the
 * rows (the committee facet's current scope).
 *
 * A `from` that joins the bill to rows of its own is written from the bill
 * (`bills m CROSS JOIN … bs ON …`, which fixes the join order), so whatever
 * tests the bill starts the count and each bill's rows are reached by key.
 * Left to choose under a tag filter or a search, the planner read every row
 * and looked its bill up by key: on an instance of 100,000 bills and 170,000
 * subject rows, 1.4 s and 340,000 rows read, where starting from the few
 * bills the tag names cost 77 ms and 40,000. `alone`, when given, is those
 * rows without the bill: rows that always have one (ON DELETE CASCADE), which
 * the whole count reads instead when nothing tests the bill, since reaching
 * each row's bill by key costs a lookup a row. A `where` given with `alone`
 * must test the rows only, never `m`.
 */
export async function countBy(db: AppDb, c: Counting, source: { values: SQL[]; from: SQL; where?: SQL; alone?: SQL; extras?: SQL[]; noComplement?: true; groupSubjects?: true }): Promise<CountRow[]> {
  const { values, from } = source
  const filter = c.where(m)
  const w = filter && source.where ? and(source.where, filter) : (source.where ?? filter)
  const keyed = await c.freshKeys?.()
  const freshTest = keyed ?? c.fresh
  const fresh = freshTest?.test(m)
  const cte = withCtes([keyed ? undefined : c.fresh?.cte])
  const select = (n: SQL) => sql.join([...valueColumns(values), n], sql`, `)
  // Counting what the filter leaves out and taking it from every row reads fewer rows than joining every bill to its rows
  // when most bills meet the filter, or, under OR, when most are fresh (the current result is held as keys, a small part).
  // It needs the rows alone (`alone`) and, under OR, no filter of the facet's own, so that every value has its rows counted.
  const complement = source.alone !== undefined && !source.noComplement && countStrategy.complement !== 'never' && (
    fresh ? !filter && keyed !== undefined : filter ? (countStrategy.complement === 'always' || await c.broad?.() === true) : false)
  // Further columns of the rows the whole count reads (the committee names), only when it reads them from the bills' rows.
  const extraCols = (source.extras ?? []).map((e, i) => sql`${e} AS ${sql.raw(`x${i}`)}`)
  const wholeFrom = !filter && !fresh && source.alone ? source.alone : from
  const wholeRows = complement
    ? Promise.all([
      db.all(sql`SELECT ${select(sql`COUNT(*) AS n`)} FROM ${source.alone!}${source.where ? sql` WHERE ${source.where}` : sql``}${groupBy(values)}`) as Promise<Record<string, unknown>[]>,
      db.all(sql`SELECT ${select(sql`COUNT(*) AS n`)} FROM ${from} WHERE ${source.where ? sql`${source.where} AND ` : sql``}COALESCE((${fresh ?? filter!}), 0) = 0${groupBy(values)}`) as Promise<Record<string, unknown>[]>,
    ]).then(([all, left]) => {
      const out = new Map(left.map(r => [keyOf(r, values.length), Number(r.n)]))
      // A value no kept row has is no value of the filter's bills: dropped, as the count over the kept rows never has it.
      return all.map(r => ({ ...r, n: Number(r.n) - (out.get(keyOf(r, values.length)) ?? 0) })).filter(r => fresh !== undefined || r.n > 0)
    })
    : db.all(sql`${cte}SELECT ${select(sql.join([sql`${countOf(fresh)} AS n`, ...extraCols], sql`, `))} FROM ${wholeFrom}${w ? sql` WHERE ${w}` : sql``}${groupBy(values)}`) as Promise<Record<string, unknown>[]>
  const everyRow = () => db.all(sql`${cte}SELECT ${sql.join([...valueNames(values), sql`COALESCE(SUM(n), 0) AS bills`, sql`${fresh ? sql`COALESCE(SUM(CASE WHEN n > 0 THEN 1 ELSE 0 END), 0)` : sql`COUNT(*)`} AS groups`], sql`, `)}
      FROM (SELECT ${select(sql`${countOf(fresh)} AS n`)} FROM ${from} WHERE ${m.groupKey} IS NOT NULL${w ? sql` AND ${w}` : sql``}
        GROUP BY ${sql.join([sql`${m.groupKey}`, ...values], sql`, `)})${groupBy(valueNames(values))}`) as Promise<Record<string, unknown>[]>
  // The subject count reads the correction from the subjects the groups share (`sharedSubjectCorrection`), and none at all
  // when no group shares one, since every group then counts once under each subject by the whole count's own rows.
  const sharing = source.groupSubjects && !source.where && c.groupsShareSubjects
  const groupedRows = sharing
    ? c.groupsShareSubjects!().then(shared => (shared ? sharedSubjectCorrection(db, keyed ? undefined : c.fresh?.cte, w, fresh) : []))
    : everyRow()
  const [whole, grouped] = await Promise.all([wholeRows, groupedRows])
  const byValue = new Map(grouped.map(r => [keyOf(r, values.length), r]))
  return whole.map(r => {
    const g = byValue.get(keyOf(r, values.length))
    return {
      values: valuesOf(r, values.length), n: Number(r.n) - Number(g?.bills ?? 0) + Number(g?.groups ?? 0),
      extra: extraCols.length > 0 && wholeFrom === from && !complement ? extraCols.map((_, i) => (r as Record<string, unknown>)[`x${i}`]) : undefined,
    }
  })
}

/**
 * Groups by the values of `values` over `from` (which names the bill `me` that
 * holds each value), counted through the holders: `holds` is true of a holder,
 * the one bill of its group with the group's current value, so each group has
 * one row and counts once, if some bill of it meets the facet's filter. The
 * holder's group is tested from the holder, through the primary key and the
 * group key index.
 */
export async function countHolders(db: AppDb, c: Counting, source: { values: SQL[]; from: SQL; holds: SQL }): Promise<CountRow[]> {
  const { values, from, holds } = source
  const keyed = await c.freshKeys?.()
  const freshTest = keyed ?? c.fresh
  const select = sql`SELECT ${sql.join([...valueColumns(values), sql`${countOf(freshTest?.test(me))} AS n`], sql`, `)} FROM ${from}`
  const w = c.where(m)
  const qualifies = w
    ? sql` AND EXISTS (SELECT 1 FROM bills m WHERE (${m.id} = ${me.id} OR ${m.groupKey} = ${me.groupKey}) AND ${w})`
    : sql``
  const rows = await db.all(sql`${withCtes([keyed ? undefined : c.fresh?.cte])}${select} WHERE ${holds}${qualifies}${groupBy(values)}`) as Record<string, unknown>[]
  return rows.map(r => ({ values: valuesOf(r, values.length), n: Number(r.n) }))
}

/**
 * The cube: the five bill-column facets (status, stage, state, session, year) and the status groups, counted from two
 * statements a request instead of two a facet. One reads the bills meeting the filter through the facets index (0124)
 * grouped by the five columns, the other the grouped bills through the group key index grouped by the group key and
 * the five, and every count is a sum over their rows (`cubeCounts`). On the largest instance the first has about 130
 * rows and the second about 9,000.
 *
 * The facts on the five columns (`facts`, each a condition on `m` that reads only those columns) are not in the WHERE:
 * each row says whether its five values meet each one, so a facet can leave its own fact out of the sum where its
 * statement of its own left it out of the WHERE. Under match=any no fact is passed and nothing is applied, and the rows
 * carry the fresh bills instead (`Counting.fresh`), each tested once in the scan.
 */
export const CUBE_COLUMNS: SQL[] = [sql`${m.status}`, sql`${m.statusStage}`, sql`${m.state}`, sql`${m.session}`, sql`${m.yearStart}`]

/** One row of a cube: the five values, the bills, the fresh bills (under match=any), the highest status rank, whether the values meet each fact, and the group of a grouped row. */
export type CubeRow = { values: unknown[]; bills: number; fresh: number; rank: number; meets: boolean[]; group?: string }

/** The two statements' rows, with the keys of the facts each row says it meets, in the order of `CubeRow.meets`. */
export type Cube = { facts: string[]; fresh: boolean; whole: CubeRow[]; grouped: CubeRow[] }

/** Counts the cube under `c`, `c.where` holding every condition but the facts on the five columns, which are `facts`. */
export async function countCube(db: AppDb, c: Counting, facts: Array<{ key: string; condition: SQL }>): Promise<Cube> {
  const w = c.where(m)
  const keyed = await c.freshKeys?.()
  const fresh = (keyed ?? c.fresh)?.test(m)
  const cte = withCtes([keyed ? undefined : c.fresh?.cte])
  const columns = [
    ...valueColumns(CUBE_COLUMNS),
    sql`COUNT(*) AS n`,
    ...(fresh ? [sql`${countOf(fresh)} AS f`] : []),
    ...facts.map((f, i) => sql`COALESCE((${f.condition}), 0) AS ${sql.raw(`c${i}`)}`),
  ]
  const [whole, grouped] = await Promise.all([
    db.all(sql`${cte}SELECT ${sql.join([...columns, sql`MAX(${m.statusRank}) AS rank`], sql`, `)} FROM bills m${w ? sql` WHERE ${w}` : sql``} GROUP BY ${sql.join(CUBE_COLUMNS, sql`, `)}`) as Promise<Record<string, unknown>[]>,
    db.all(sql`${cte}SELECT ${sql.join([sql`${m.groupKey} AS gk`, ...columns], sql`, `)} FROM bills m WHERE ${m.groupKey} IS NOT NULL${w ? sql` AND ${w}` : sql``} GROUP BY ${sql.join([sql`${m.groupKey}`, ...CUBE_COLUMNS], sql`, `)}`) as Promise<Record<string, unknown>[]>,
  ])
  const row = (r: Record<string, unknown>): CubeRow => ({
    values: valuesOf(r, CUBE_COLUMNS.length),
    bills: Number(r.n),
    fresh: fresh ? Number(r.f) : Number(r.n),
    rank: Number(r.rank ?? 0),
    meets: facts.map((_, i) => Number(r[`c${i}`]) !== 0),
    group: r.gk === undefined ? undefined : String(r.gk),
  })
  return { facts: facts.map(f => f.key), fresh: fresh !== undefined, whole: whole.map(row), grouped: grouped.map(row) }
}

/** The whole cube's rows whose values meet every fact but `omit` (a facet's own, which it leaves out). */
export const cubeRows = (cube: Cube, omit?: string) => cube.whole.filter(r => r.meets.every((ok, i) => ok || cube.facts[i] === omit))

/**
 * Each value of the cube's column `column` (one row with no values, when it is undefined) counted as `countBy` counts
 * it, from the rows whose values meet every fact but `omit`: the bills (under match=any the fresh ones), less the
 * grouped bills, plus their groups, each group once however many of its rows have the value.
 */
export function cubeCounts(cube: Cube, column: number | undefined, omit?: string): CountRow[] {
  const valueOf = (r: CubeRow) => (column === undefined ? undefined : r.values[column])
  const kept = (r: CubeRow) => r.meets.every((ok, i) => ok || cube.facts[i] === omit)
  const counts = new Map<unknown, number>()
  if (column === undefined) counts.set(undefined, 0)
  for (const r of cube.whole) if (kept(r)) counts.set(valueOf(r), (counts.get(valueOf(r)) ?? 0) + r.fresh)
  // Each value's grouped bills, by group: a group counts once under a value, if some of its bills there count.
  const groups = new Map<unknown, Map<string, number>>()
  for (const r of cube.grouped) {
    if (!kept(r)) continue
    const byGroup = groups.get(valueOf(r)) ?? new Map<string, number>()
    byGroup.set(r.group!, (byGroup.get(r.group!) ?? 0) + r.fresh)
    groups.set(valueOf(r), byGroup)
  }
  for (const [value, byGroup] of groups) {
    let n = counts.get(value) ?? 0
    for (const bills of byGroup.values()) n += (bills > 0 || !cube.fresh ? 1 : 0) - bills
    counts.set(value, n)
  }
  return [...counts].map(([value, n]) => ({ values: column === undefined ? [] : [value], n }))
}

/**
 * The groups of the current result, from a cube counted under match=any (over the scopes alone, with the fresh bills):
 * a bill in no group is in it when it is not fresh, and a group when none of its bills is fresh, since a group's bills
 * are all fresh or none are. It is the list's total, `countGroups` of the current filter.
 */
export function currentOfCube(cube: Cube): number {
  const sum = (rows: CubeRow[], of: (r: CubeRow) => number) => rows.reduce((a, r) => a + of(r), 0)
  const alone = (sum(cube.whole, r => r.bills) - sum(cube.grouped, r => r.bills)) - (sum(cube.whole, r => r.fresh) - sum(cube.grouped, r => r.fresh))
  const freshByGroup = new Map<string, number>()
  for (const r of cube.grouped) freshByGroup.set(r.group!, (freshByGroup.get(r.group!) ?? 0) + r.fresh)
  return alone + [...freshByGroup.values()].filter(f => f === 0).length
}
