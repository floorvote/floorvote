import { Hono } from 'hono'
import { requireAuth } from '../../middleware/auth'
import type { AppEnv } from '../../types'
import { registerBulkRoutes } from './bulkRoutes'
import { registerListRoutes } from './listRoutes'
import { registerLookupRoutes } from './lookupRoutes'
import { registerEngagementRoutes } from './engagementRoutes'
import { registerDraftRoutes } from './draftRoutes'
import { registerTextRoutes } from './textRoutes'

export const billsApiRouter = new Hono<AppEnv>()

billsApiRouter.use('*', requireAuth)

// Route map (which module owns what). Registration order preserves the original
// single-file order: static GET routes (/bulk-values, /facets, /drafts,
// /draft-defaults, /resolve/*) are registered before the catch-all GET /:id so
// they can never be captured as an :id param. registerDraftRoutes is registered
// before registerLookupRoutes for exactly this reason — its GET /draft-defaults
// must win against lookupRoutes' GET /:id. Its other routes use DELETE/POST/PATCH
// on /:id, which don't collide with lookupRoutes' GET methods. Shared helpers:
// query.ts (filter/sort WHERE + ORDER BY), detail.ts (buildBillDetail — the
// composite bill payload).
registerBulkRoutes(billsApiRouter)        // POST /bulk, GET /bulk-values
registerListRoutes(billsApiRouter)        // GET / (list), GET /facets
registerDraftRoutes(billsApiRouter)       // GET /draft-defaults, DELETE /:id, POST /draft, POST /:id/link, PATCH /:id/{draft,priority}
registerLookupRoutes(billsApiRouter)      // GET /:id, GET /resolve/*, GET /drafts, GET /:id/changes
registerEngagementRoutes(billsApiRouter)  // votes, position, comments, note, custom-fields
registerTextRoutes(billsApiRouter)        // GET /:id/text/:docId
