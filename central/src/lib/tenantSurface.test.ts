import { describe, it, expect } from 'vitest'
import { isTenantSurfaceAllowed } from './tenantSurface'

describe('tenantSurface allowlist matcher', () => {
  describe('allowed operations', () => {
    const allowed: [string, string][] = [
      ['GET', '/api/bills/legiscan:123'],
      ['GET', '/api/bills/legiscan:123/text'],
      ['GET', '/api/bills/legiscan:123/text/9'],
      ['GET', '/api/bills/legiscan:123/changes'],
      ['GET', '/api/bills/sessions'],
      ['GET', '/api/bills/sessions?state=RI'],
      ['POST', '/api/bills/rich-batch'],
      ['POST', '/api/tenants/register'],
      ['POST', '/api/tenants/reprocess/ri'],
      ['POST', '/api/tenants/promote-bill/ri/legiscan:123'],
      ['POST', '/api/tenants/promote-bills/ri'],
      ['GET', '/api/tenants/ri/upcoming-hearings'],
      ['GET', '/api/tenants/ri/upcoming-hearings?days=14'],
      ['POST', '/api/admin/sync-keywords/ri'],
      ['POST', '/api/admin/update-bill-match-types/ri'],
      ['POST', '/api/admin/reprocess-tenant/ri'],
      ['GET', '/api/admin/superadmin/check'],
      ['GET', '/api/admin/superadmin/check?email=x@y.org'],
    ]
    it.each(allowed)('allows %s %s', (method, path) => {
      expect(isTenantSurfaceAllowed(method, path)).toBe(true)
    })
  })

  describe('blocked operations (must be denied)', () => {
    const blocked: [string, string][] = [
      ['POST', '/api/admin/superadmin/mint'],
      ['POST', '/api/admin/reingest-tenant/ri'],
      ['POST', '/api/admin/anomaly-watch'],
      ['POST', '/api/admin/trigger-sync'],
      ['POST', '/api/admin/backfill-match-types'],
      ['POST', '/api/tenants/ri/demo-reset'],
      ['POST', '/api/tenants/ri/run-digest'],
      ['POST', '/api/tenants/ri/refresh-metadata'],
      ['POST', '/api/tenants/ri/send-sample-email'],
      // unknown paths
      ['GET', '/api/admin/anything-else'],
      ['GET', '/api/unknown'],
      ['GET', '/'],
      ['GET', '/api'],
      // method mismatches on otherwise-allowed paths
      ['DELETE', '/api/bills/legiscan:123'],
      ['POST', '/api/bills/legiscan:123'],
      ['GET', '/api/tenants/register'],
      ['GET', '/api/admin/sync-keywords/ri'],
      // extra segments must not be swallowed by :id wildcards
      ['GET', '/api/bills/legiscan:123/changes/extra'],
      ['GET', '/api/bills/legiscan:123/text/9/extra'],
      ['POST', '/api/tenants/reprocess/ri/extra'],
      ['GET', '/api/admin/superadmin/check/extra'],
      ['POST', '/api/admin/superadmin'],
    ]
    it.each(blocked)('blocks %s %s', (method, path) => {
      expect(isTenantSurfaceAllowed(method, path)).toBe(false)
    })
  })

  describe('normalization / evasion resistance', () => {
    it('blocks mint regardless of trailing slash', () => {
      expect(isTenantSurfaceAllowed('POST', '/api/admin/superadmin/mint/')).toBe(false)
    })
    it('tolerates a trailing slash on an allowed path (still allowed)', () => {
      expect(isTenantSurfaceAllowed('GET', '/api/bills/sessions/')).toBe(true)
    })
    it('is case-insensitive on the HTTP method', () => {
      expect(isTenantSurfaceAllowed('get', '/api/bills/sessions')).toBe(true)
      expect(isTenantSurfaceAllowed('post', '/api/tenants/register')).toBe(true)
    })
    it('lowercases static path segments so case tricks cannot dodge the allowlist', () => {
      // A static-segment case variant of an allowed path still matches.
      expect(isTenantSurfaceAllowed('GET', '/api/BILLS/sessions')).toBe(true)
      // A static-segment case variant of a blocked path still blocks.
      expect(isTenantSurfaceAllowed('POST', '/api/ADMIN/superadmin/MINT')).toBe(false)
    })
    it('decodes percent-encoding before matching so encoded mint is blocked', () => {
      // %6d = 'm' -> would spell "mint" if naively passed through
      expect(isTenantSurfaceAllowed('POST', '/api/admin/superadmin/%6dint')).toBe(false)
    })
    it('blocks %2e path-traversal / dot smuggling against an allowed prefix', () => {
      // /api/admin/superadmin/check/%2e%2e/mint -> normalizes to .../mint
      expect(isTenantSurfaceAllowed('POST', '/api/admin/superadmin/check/%2e%2e/mint')).toBe(false)
    })
    it('does not let a wildcard segment contain an encoded slash to gain a segment', () => {
      // %2f decodes to '/', which would smuggle an extra path segment into :id
      expect(isTenantSurfaceAllowed('POST', '/api/tenants/reprocess/ri%2fextra')).toBe(false)
    })
    it('collapses duplicate slashes', () => {
      expect(isTenantSurfaceAllowed('POST', '/api//admin//superadmin//mint')).toBe(false)
      expect(isTenantSurfaceAllowed('GET', '/api//bills//sessions')).toBe(true)
    })
    it('rejects empty wildcard segments', () => {
      expect(isTenantSurfaceAllowed('GET', '/api/bills/')).toBe(false)
      expect(isTenantSurfaceAllowed('POST', '/api/tenants/reprocess/')).toBe(false)
    })
  })

  // Regression guard for the bug where `GET /bills/:id/text/:docId` (the per-version
  // bill-text fetch the web text panel uses on EVERY bill) was left off the allowlist,
  // so the deny-by-default forwarder 403'd it on all tenants for ~3 days.
  //
  // This is the canonical list of EVERY operation a tenant invokes against central
  // over the service binding — one entry per distinct (method, path) that
  // `centralFetch` sends, with the calling site(s) in api/. The allowlist MUST be a
  // superset of this list. When you add a `centralFetch(...)` call in api/, add the
  // operation here AND to ALLOW in tenantSurface.ts, or this test fails.
  //
  // Param segments use representative values: `legiscan:123` (bill externalId),
  // `ri` (tenantId), `9` (text docId).
  describe('every real tenant→central caller is allowlisted', () => {
    const callerOps: [string, string, string][] = [
      // [method, path, where it is called from in api/]
      ['GET',  '/api/bills/legiscan:123',                      'queue/processor.ts, billsApi/detail.ts'],
      ['GET',  '/api/bills/legiscan:123/text',                 'queue/processor.ts (AI text fetch)'],
      ['GET',  '/api/bills/legiscan:123/text/9',               'billsApi/textRoutes.ts (text panel)'],
      ['GET',  '/api/bills/legiscan:123/changes',              'billsApi/lookupRoutes.ts'],
      ['GET',  '/api/bills/sessions?state=RI',                 'routes/configApi.ts'],
      ['GET',  '/api/tenants/ri/upcoming-hearings?days=14',    'routes/stats.ts'],
      ['GET',  '/api/admin/superadmin/emails',                 'lib/superadminCentral.ts'],
      ['POST', '/api/tenants/register',                        'index.ts, cron/sync.ts'],
      ['POST', '/api/tenants/reprocess/ri',                    'lib/demoResetAndSeed.ts, lib/calendarBackfill.ts'],
      ['POST', '/api/tenants/promote-bill/ri/legiscan:123',    'routes/adminApi.ts, billsApi/draftRoutes.ts'],
      ['POST', '/api/tenants/promote-bills/ri',                'billsApi/bulkRoutes.ts'],
      ['POST', '/api/bills/rich-batch',                        'routes/exportApi.ts'],
      ['POST', '/api/admin/sync-keywords/ri',                  'routes/adminApi.ts'],
      ['POST', '/api/admin/update-bill-match-types/ri',        'routes/adminApi.ts'],
      ['POST', '/api/admin/reprocess-tenant/ri',               'lib/demoResetAndSeed.ts'],
    ]
    it.each(callerOps)('allows %s %s (called from %s)', (method, path) => {
      expect(isTenantSurfaceAllowed(method, path)).toBe(true)
    })
  })
})
