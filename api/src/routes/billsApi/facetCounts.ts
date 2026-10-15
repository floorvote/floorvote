import { sql, type SQL } from 'drizzle-orm'
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
 *   (`countBy`).
 * - A team field (priority, position, tags, custom fields): the group has one
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
  /** The facet's filter on a bill (`many`: see BillsFilter), undefined for every bill. */
  where: BillsFilter
  /** Under OR: true for a bill of a group none of whose bills is in the current result. */
  fresh: ((t: BillsTable) => SQL) | undefined
}

/** A group's bills' values of the columns counted, and the number of groups. */
export type CountRow = { values: unknown[]; n: number }

/**
 * True for a bill in no group meeting the current result, and for a bill of a
 * group none of whose bills meets it. The group's bills in the result come from
 * one list, built once for the statement, not found by a probe of each bill's group.
 */
export function freshOf(current: BillsFilter): (t: BillsTable) => SQL {
  const cm = billsAs('cm')
  return t => sql`CASE WHEN ${t.groupKey} IS NULL THEN COALESCE((${current(t, true)}), 0) = 0
    ELSE ${t.groupKey} NOT IN (SELECT cm.group_key FROM bills cm WHERE cm.group_key IS NOT NULL AND ${current(cm, true)}) END`
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
 */
export async function countBy(db: AppDb, c: Counting, source: { values: SQL[]; from: SQL }): Promise<CountRow[]> {
  const { values, from } = source
  const w = c.where(m, true)
  const fresh = c.fresh?.(m)
  const [whole, grouped] = await Promise.all([
    db.all(sql`SELECT ${sql.join([...valueColumns(values), sql`${countOf(fresh)} AS n`], sql`, `)} FROM ${from}${w ? sql` WHERE ${w}` : sql``}${groupBy(values)}`) as Promise<Record<string, unknown>[]>,
    db.all(sql`SELECT ${sql.join([...valueNames(values), sql`COALESCE(SUM(n), 0) AS bills`, sql`${fresh ? sql`COALESCE(SUM(CASE WHEN n > 0 THEN 1 ELSE 0 END), 0)` : sql`COUNT(*)`} AS groups`], sql`, `)}
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
 *
 * `many` says there are many holders (tags: every analyzed bill holds one), so
 * a probe of each holder's group would cost more than the bills meeting the
 * filter. Those are read once, through whatever index the filter has, and a
 * holder is one of them or shares a group with one: a filter that picks few
 * bills then starts from them, as before groups, not from every holder.
 */
export async function countHolders(db: AppDb, c: Counting, source: { values: SQL[]; from: SQL; holds: SQL; many?: boolean }): Promise<CountRow[]> {
  const { values, from, holds } = source
  const select = sql`SELECT ${sql.join([...valueColumns(values), sql`${countOf(c.fresh?.(me))} AS n`], sql`, `)} FROM ${from}`
  const w = source.many ? c.where(m, true) : c.where(m)
  let rows: Record<string, unknown>[]
  if (w && source.many) {
    rows = await db.all(sql`WITH q AS MATERIALIZED (SELECT ${m.id} AS id, ${m.groupKey} AS gk FROM bills m WHERE ${w})
      ${select} WHERE ${holds} AND (${me.id} IN (SELECT id FROM q) OR ${me.groupKey} IN (SELECT gk FROM q WHERE gk IS NOT NULL))${groupBy(values)}`) as Record<string, unknown>[]
  } else {
    const qualifies = w
      ? sql` AND EXISTS (SELECT 1 FROM bills m WHERE (${m.id} = ${me.id} OR ${m.groupKey} = ${me.groupKey}) AND ${w})`
      : sql``
    rows = await db.all(sql`${select} WHERE ${holds}${qualifies}${groupBy(values)}`) as Record<string, unknown>[]
  }
  return rows.map(r => ({ values: valuesOf(r, values.length), n: Number(r.n) }))
}
