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
