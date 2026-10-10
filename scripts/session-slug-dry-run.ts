#!/usr/bin/env tsx
/**
 * Dry run of central's session slugs (migration 0031) against a real central's
 * sessions. Reads rows on stdin, writes nothing, and prints every session
 * whose name asks for a slug another session of its state would hold first,
 * with the slug it would get instead. Exits 0 either way.
 *
 * A central from before the provider column (main before provider-model):
 *
 *   npx wrangler d1 execute central-bills-ls --env legiscan --remote --json \
 *     --command "SELECT session_id, state, session_name FROM sessions" \
 *     | npx tsx scripts/session-slug-dry-run.ts
 *
 * A central with provider ownership (provider-model, after migration 0030):
 *
 *   npx wrangler d1 execute central-bills-ls --env legiscan --remote --json \
 *     --command "SELECT s.session_id, s.state, s.session_name, s.provider, COALESCE(sp.provider, 'legiscan') AS owner FROM sessions s LEFT JOIN state_providers sp ON sp.state = s.state" \
 *     | npx tsx scripts/session-slug-dry-run.ts
 *
 * CSV of session_id,state,session_name on stdin works too. Run from central/
 * if wrangler needs central's config.
 */
import { readFileSync } from 'fs'
import { dryRunSlugs, parseSessionRows } from './lib/session-slug-dry-run'

const rows = parseSessionRows(readFileSync(0, 'utf8'))
const collisions = dryRunSlugs(rows)
console.log(`${rows.length} sessions, ${collisions.length} would not get the slug their name asks for.`)
for (const c of collisions.sort((a, b) => a.state.localeCompare(b.state) || a.sessionId - b.sessionId)) {
  console.log(`${c.state}\t${c.sessionId}\t${c.provider ?? 'legiscan'}\t"${c.sessionName}"\twants ${c.wanted}, gets ${c.slug}`)
}
