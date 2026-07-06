// Re-export of the single source of truth at shared/superadminJwt.ts.
// Central previously kept a byte-identical copy here; that was a drift hazard
// for security-critical claim validation, so the logic now lives only in shared/
// (reachable from central exactly like shared/brand.ts). This shim keeps central's
// existing `./superadminJwt` / `../lib/superadminJwt` import paths working.
export * from '../../../shared/superadminJwt'
