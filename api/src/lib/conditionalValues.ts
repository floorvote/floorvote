import { getTableColumns, SQL, sql } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

/**
 * VALUES as a conditional SELECT for an insert in a D1 batch. The condition is
 * evaluated inside the transaction, after the bill's version write, so child
 * rows are skipped when that write declined an older version. Keep column
 * order, defaults and encoders from the table (notably boolean columns).
 */
export function conditionalValues<T extends SQLiteTable>(table: T, rows: T['$inferInsert'][], condition: SQL): SQL {
  const columns = Object.entries(getTableColumns(table))
  const values = rows.map(row => sql`(${sql.join(columns.map(([key, column]) => {
    const supplied = (row as Record<string, unknown>)[key]
    const value = supplied === undefined ? column.defaultFn?.() ?? column.default ?? null : supplied
    return value instanceof SQL ? value : sql.param(value, column)
  }), sql`, `)})`)
  return sql`SELECT * FROM (VALUES ${sql.join(values, sql`, `)}) WHERE ${condition}`
}
