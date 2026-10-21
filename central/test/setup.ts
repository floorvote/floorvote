// Runs before every test file (vitest `setupFiles`): builds the LegiScan
// central schema once per file. Each file has its own storage, so the
// migrations run here, and a test that needs a clean database calls clearDb()
// in its beforeEach, which empties the tables rather than rebuilding them.
// Before this, every test wiped storage and replayed all 41 migrations; the
// same change in api is #807, and the CI numbers are in #804. The migration
// and fork-upgrade tests still rebuild on purpose, with setupDb().
//
// The helpers are loaded lazily, inside the beforeAll, and must stay that
// way: importing `cloudflare:test` from this file's static import graph (it,
// or any module it imports) stops a test file's vi.mock() calls from taking
// effect (found in api, #807). By the time a beforeAll runs, the test file's
// own imports and mocks are registered, so loading the module then is the
// same as the test file importing it itself.
import { beforeAll, beforeEach } from 'vitest'

beforeAll(async () => {
  const { env, applyD1Migrations } = await import('cloudflare:test')
  const { legiscanMigrations, parseMigrations, rememberSchema } = await import('./helpers/migrations')
  await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))
  await rememberSchema()
})

// The handle-form cache (lib/tenantHandles.ts) lives for the isolate, keyed by
// tenant. Tests reuse tenant ids with different bindings, so each starts empty.
beforeEach(async () => {
  const { forgetHandleForms } = await import('../src/lib/tenantHandles')
  forgetHandleForms()
})
