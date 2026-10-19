/// <reference types="vite/client" />
import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test'
import { splitStatements } from '../../../shared/sqlStatements'

// Migration files keyed by path, valued by raw SQL: the shape
// import.meta.glob(..., { query: '?raw', import: 'default', eager: true })
// returns. Only the file's basename matters, so any folder can be loaded.
export type MigrationFiles = Record<string, string>

// Every file in central's migrations directory, so a new migration is
// applied by the tests the moment it lands, with no list to update.
// import.meta.glob needs a literal pattern: to load another folder (a fork's
// migrations, say), call it in the test with that folder's path and pass the
// result to setupDb().
export const legiscanMigrations: MigrationFiles = import.meta.glob<string>(
  '../../migrations-legiscan/*.sql', { query: '?raw', import: 'default', eager: true },
)

// All migrations in filename order (wrangler's order), named by basename
// without the extension.
export function parseMigrations(files: MigrationFiles): D1Migration[] {
  return Object.entries(files)
    .map(([path, sql]) => ({ name: path.split('/').pop()!.replace(/\.sql$/, ''), sql }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sql }) => ({ name, queries: splitStatements(sql) }))
}

// Wipe env.DB and build it from scratch with every migration in `files`.
export async function setupDb(files: MigrationFiles): Promise<void> {
  await reset()
  await applyD1Migrations(env.DB, parseMigrations(files))
}

// The migrated schema's tables, and the rows the migrations themselves insert
// (0010 seeds settings; 0026 and 0035 seed source and committee rows),
// remembered once per file by test/setup.ts so clearDb() can empty every
// table and put those rows back.
let schema: { tables: string[]; hasSequences: boolean; seeded: { table: string; columns: string[]; rows: unknown[][] }[] } | undefined

export async function rememberSchema(): Promise<void> {
  const { results } = await env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")
    .all<{ name: string }>()
  const tables = results.map(r => r.name)
  // Four tables are AUTOINCREMENT; their counters live in sqlite_sequence and
  // survive a DELETE, so a fresh database's ids come back only if that is
  // emptied too (the seeded rows below then set it as the migrations did).
  const hasSequences = (await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").first()) !== null
  const seeded: NonNullable<typeof schema>['seeded'] = []
  for (const table of tables) {
    const { results: rows } = await env.DB.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>()
    if (rows.length === 0) continue
    const columns = Object.keys(rows[0])
    seeded.push({ table, columns, rows: rows.map(r => columns.map(c => r[c])) })
  }
  schema = { tables, hasSequences, seeded }
}

/**
 * Empty every table and restore the rows the migrations seeded: the database
 * as a fresh migration leaves it, for about the cost of one query. The schema
 * itself is built once per file by test/setup.ts; a test's rows are not undone
 * for it by the pool, so a file that writes calls this before each test.
 * (setupDb() does the same by wiping storage and replaying every migration,
 * which the migration and fork-upgrade tests need and nothing else does.)
 */
export async function clearDb(): Promise<void> {
  if (!schema) throw new Error('clearDb() needs the schema that test/setup.ts builds and remembers')
  const quote = (name: string) => `"${name}"`
  await env.DB.batch([
    // Parents and children empty in one transaction, whatever the order.
    env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
    ...schema.tables.map(t => env.DB.prepare(`DELETE FROM ${quote(t)}`)),
    ...(schema.hasSequences ? [env.DB.prepare('DELETE FROM sqlite_sequence')] : []),
    ...schema.seeded.flatMap(({ table, columns, rows }) =>
      rows.map(row => env.DB
        .prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .bind(...row))),
  ])
}
