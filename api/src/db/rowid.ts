import { getTableName, sql, type SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

// SQLite's implicit rowid for a table, as a SQL fragment for ORDER BY. Drizzle
// has no rowid column, so this renders "<table>"."rowid" using the name the
// table reference carries. For an aliased table (aliasedTable(comments, 'c'))
// that is the alias, so the fragment still resolves inside the query.
export function rowidOf(table: SQLiteTable): SQL {
  return sql`${sql.identifier(getTableName(table))}.${sql.identifier('rowid')}`
}
