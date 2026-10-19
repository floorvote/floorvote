// The api schema for tests: the migration list, how to build it, and how to
// empty it. Deliberately imports nothing from src/: test/setup.ts runs this
// before each test file's own imports, and a module loaded there is loaded for
// good, beyond the reach of that file's vi.mock() calls. helpers.ts imports
// the whole app and re-exports these, so test files keep one import.
import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { splitStatements } from '../../shared/sqlStatements'

// Every file in api/migrations/, so a new migration is applied by the tests the
// moment it lands, with no list to update. test/migrations/allApplied.test.ts
// fails if any file is left out.
const migrationFiles = import.meta.glob<string>('../migrations/*.sql', { query: '?raw', import: 'default', eager: true })

export function parseMigration(sql: string, name: string) {
  return { name, queries: splitStatements(sql) }
}

/**
 * Migration files keyed by path, valued by raw SQL (what
 * import.meta.glob(..., { query: '?raw', import: 'default', eager: true })
 * returns), as migrations in filename order, each named by its basename
 * without the extension, like applyMigrations' names. For building a database
 * from a whole folder, such as a fork's (test/migrations/forkUpgrade.test.ts).
 */
export function migrationsFromFiles(files: Record<string, string>): { name: string; queries: string[] }[] {
  return Object.entries(files)
    .map(([path, sql]) => ({ name: path.split('/').pop()!.replace(/\.sql$/, ''), sql }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sql }) => ({ name, queries: splitStatements(sql) }))
}

export async function resetDb(): Promise<void> {
  await reset()
}

// The migrated schema's tables, and the rows the migrations themselves insert
// (0001 seeds association_config), remembered once per file by test/setup.ts
// so clearDb() can empty every table and put those rows back.
let schema: { tables: string[]; seeded: { table: string; columns: string[]; rows: unknown[][] }[] } | undefined

export async function rememberSchema(): Promise<void> {
  const { results } = await env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")
    .all<{ name: string }>()
  const tables = results.map(r => r.name)
  const seeded: NonNullable<typeof schema>['seeded'] = []
  for (const table of tables) {
    const { results: rows } = await env.DB.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>()
    if (rows.length === 0) continue
    const columns = Object.keys(rows[0])
    seeded.push({ table, columns, rows: rows.map(r => columns.map(c => r[c])) })
  }
  schema = { tables, seeded }
}

/**
 * Empty every table and restore the rows the migrations seeded: the database
 * as a fresh migration leaves it, for about the cost of one query. The schema
 * itself is built once per file by test/setup.ts; a test's rows are not undone
 * for it by the pool, so a file that writes calls this before each test.
 * (resetDb() + applyMigrations() does the same by wiping storage and replaying
 * every migration, which is what the migration tests need and nothing else.)
 */
export async function clearDb(): Promise<void> {
  if (!schema) throw new Error('clearDb() needs the schema that test/setup.ts builds and remembers')
  const quote = (name: string) => `"${name}"`
  await env.DB.batch([
    // Parents and children empty in one transaction, whatever the order.
    env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
    ...schema.tables.map(t => env.DB.prepare(`DELETE FROM ${quote(t)}`)),
    ...schema.seeded.flatMap(({ table, columns, rows }) =>
      rows.map(row => env.DB
        .prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .bind(...row))),
  ])
}

/**
 * Apply every migration. With `before`, apply only those whose names sort
 * before it, so a test can seed rows as an older database holds them and then
 * call applyMigrations() again to run the rest over them.
 */
export async function applyMigrations(opts: { before?: string } = {}): Promise<void> {
  const migrations = migrationsFromFiles(migrationFiles)
  const before = opts.before
  await applyD1Migrations(env.DB, before ? migrations.filter(m => m.name < before) : migrations)
}
