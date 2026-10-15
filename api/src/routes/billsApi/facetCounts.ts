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
 *   (`countBy`). Tags count this way too: every bill stores its group's
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
}

/**
 * What a statement that counts only groups none of whose bills is in the current result needs: `test` is true
 * of a bill of such a group, and `cte`, when there is one, starts the statement.
 */
export type Fresh = { cte?: SQL; test: (t: BillsTable) => SQL }

/** A group's bills' values of the columns counted, and the number of groups. */
export type CountRow = { values: unknown[]; n: number }

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
 * Groups by the values of `values` over `from` (which names the bill `m`), each
 * counted once: the bills as before groups, less the grouped bills, plus their
 * groups. The grouped bills are read through the group key index, in its order
 * (the group key first), so a group's bills are met together and no group is
 * counted by a set of its own. With no values, one row counts all groups.
 * `where`, when given, is a further condition on `m`, of the facet rather than
 * of the filter (the tag facets count only bills with group tags).
 */
export async function countBy(db: AppDb, c: Counting, source: { values: SQL[]; from: SQL; where?: SQL }): Promise<CountRow[]> {
  const { values, from } = source
  const filter = c.where(m)
  const w = filter && source.where ? and(source.where, filter) : (source.where ?? filter)
  const fresh = c.fresh?.test(m)
  const cte = withCtes([c.fresh?.cte])
  const [whole, grouped] = await Promise.all([
    db.all(sql`${cte}SELECT ${sql.join([...valueColumns(values), sql`${countOf(fresh)} AS n`], sql`, `)} FROM ${from}${w ? sql` WHERE ${w}` : sql``}${groupBy(values)}`) as Promise<Record<string, unknown>[]>,
    db.all(sql`${cte}SELECT ${sql.join([...valueNames(values), sql`COALESCE(SUM(n), 0) AS bills`, sql`${fresh ? sql`COALESCE(SUM(CASE WHEN n > 0 THEN 1 ELSE 0 END), 0)` : sql`COUNT(*)`} AS groups`], sql`, `)}
      FROM (SELECT ${sql.join([...valueColumns(values), sql`${countOf(fresh)} AS n`], sql`, `)} FROM ${from} WHERE ${m.groupKey} IS NOT NULL${w ? sql` AND ${w}` : sql``}
        GROUP BY ${sql.join([sql`${m.groupKey}`, ...values], sql`, `)})${groupBy(valueNames(values))}`) as Promise<Record<string, unknown>[]>,
  ])
  const byValue = new Map(grouped.map(r => [keyOf(r, values.length), r]))
  return whole.map(r => {
    const g = byValue.get(keyOf(r, values.length))
    return { values: valuesOf(r, values.length), n: Number(r.n) - Number(g?.bills ?? 0) + Number(g?.groups ?? 0) }
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
  const select = sql`SELECT ${sql.join([...valueColumns(values), sql`${countOf(c.fresh?.test(me))} AS n`], sql`, `)} FROM ${from}`
  const w = c.where(m)
  const qualifies = w
    ? sql` AND EXISTS (SELECT 1 FROM bills m WHERE (${m.id} = ${me.id} OR ${m.groupKey} = ${me.groupKey}) AND ${w})`
    : sql``
  const rows = await db.all(sql`${withCtes([c.fresh?.cte])}${select} WHERE ${holds}${qualifies}${groupBy(values)}`) as Record<string, unknown>[]
  return rows.map(r => ({ values: valuesOf(r, values.length), n: Number(r.n) }))
}
