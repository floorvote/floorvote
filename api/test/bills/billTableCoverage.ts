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
    .filter(t => getTableConfig(t).columns.some(c => BILL_ID_COLUMN.test(c.name)) || billForeignKeys(t).length > 0)
    .map(getTableName)
}

function billForeignKeys(table: SQLiteTable) {
  return getTableConfig(table).foreignKeys.filter(fk => getTableName(fk.reference().foreignTable) === 'bills')
}

/** Tables whose treatment says a row cascades with the draft; each must really have a cascading foreign key to `bills`. */
export function cascadeClaimProblems(schema: Record<string, unknown>, classification: Record<string, Treatment>): string[] {
  const byName = new Map(tables(schema).map(t => [getTableName(t), t]))
  return Object.entries(classification)
    .filter(([, t]) => t.link === 'cascade' || t.delete === 'cascade')
    .filter(([name]) => {
      const table = byName.get(name)
      return !table || !billForeignKeys(table).some(fk => fk.onDelete === 'cascade')
    })
    .map(([name]) => `${name} is classified as cascade but has no foreign key to bills with onDelete cascade`)
}

export function coverageProblems(linked: readonly string[], classification: Record<string, Treatment>, allTables: readonly string[]): string[] {
  return [
    ...linked.filter(t => !(t in classification)).map(t => `${t} holds a bill id but is not classified in billTableTreatment.ts`),
    ...Object.keys(classification).filter(t => !allTables.includes(t)).map(t => `${t} is classified but is no longer in the schema`),
  ]
}
