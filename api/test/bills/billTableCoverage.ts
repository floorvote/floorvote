import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { getTableName, is } from 'drizzle-orm'

/** What draft Link (POST /bills/:id/link) and draft delete (DELETE /bills/:id) do with a table's rows for the draft. */
export type Treatment = {
  link: 'moved' | 'cascade' | 'not-applicable'
  delete: 'deleted' | 'cascade' | 'not-applicable'
  reason: string
}

const BILL_ID_COLUMN = /(^|_)bill_ids?$/

function tables(schema: Record<string, unknown>): SQLiteTable[] {
  return Object.values(schema).filter((v): v is SQLiteTable => is(v, SQLiteTable))
}

export function schemaTableNames(schema: Record<string, unknown>): string[] {
  return tables(schema).map(getTableName)
}

/** Tables with a column that holds a bill id. `bills` itself is the draft, so its own related-bill columns don't count. */
export function billLinkedTables(schema: Record<string, unknown>): string[] {
  return tables(schema)
    .filter(t => getTableName(t) !== 'bills')
    .filter(t => getTableConfig(t).columns.some(c => BILL_ID_COLUMN.test(c.name)))
    .map(getTableName)
}

export function coverageProblems(linked: readonly string[], classification: Record<string, Treatment>, allTables: readonly string[]): string[] {
  return [
    ...linked.filter(t => !(t in classification)).map(t => `${t} holds a bill id but is not classified in billTableTreatment.ts`),
    ...Object.keys(classification).filter(t => !allTables.includes(t)).map(t => `${t} is classified but is no longer in the schema`),
  ]
}
