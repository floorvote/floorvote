#!/usr/bin/env tsx
/**
 * DEPRECATED — use `seed-legiscan.ts --from-dir <path> ...` instead.
 *
 * This script's behavior has been merged into the consolidated
 * `scripts/seed-legiscan.ts` (which also subsumes the old
 * `seed-state-api.ts`). The new script supports both --from-dir (local
 * extracted dataset) and --from-api (LegiScan API download) source modes,
 * with an optional --tenant flag that auto-links bills via seed-session and
 * ensures tenant.state_coverage includes the new state.
 *
 * Translation:
 *
 *   OLD: npx tsx scripts/seed-legiscan-central.ts \
 *          --dir bulkseeds/legiscan/US/2025-2026_119th_Congress \
 *          --state US --session-id 2199 \
 *          --db-name central-bills-ls --env legiscan --remote
 *
 *   NEW: npx tsx scripts/seed-legiscan.ts \
 *          --from-dir bulkseeds/legiscan/US/2025-2026_119th_Congress \
 *          --state US --session-id 2199 \
 *          --remote
 *        (plus optional --tenant my-org to link tenants in one shot)
 */

console.error('\n❌  scripts/seed-legiscan-central.ts is DEPRECATED.')
console.error('   Use scripts/seed-legiscan.ts with --from-dir instead. See the file header for examples.\n')
process.exit(1)
