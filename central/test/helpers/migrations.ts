/// <reference types="vite/client" />
import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test'

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

// Split a migration into statements on `;`, dropping `--` and `/* */`
// comments first and ignoring semicolons inside quotes, so prose in a comment
// can't leak out as SQL. Not handled: a CREATE TRIGGER body (BEGIN ... END)
// has semicolons of its own and would be split apart.
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: string | null = null
  const flush = () => {
    const s = current.trim()
    if (s.length > 0) statements.push(s + ';')
    current = ''
  }
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      current += c
      if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c
      current += c
    } else if (c === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i)
      i = eol === -1 ? sql.length : eol - 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 1
    } else if (c === ';') {
      flush()
    } else {
      current += c
    }
  }
  flush()
  return statements
}

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
