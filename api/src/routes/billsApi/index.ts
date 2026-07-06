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
// single-file order: static GET routes (/bulk-values, /facets, /drafts, /resolve/*)
// are registered before the catch-all GET /:id so they can never be captured as an
// :id param. Shared helpers: query.ts (filter/sort WHERE + ORDER BY), detail.ts
// (buildBillDetail — the composite bill payload).
registerBulkRoutes(billsApiRouter)        // POST /bulk, GET /bulk-values
registerListRoutes(billsApiRouter)        // GET / (list), GET /facets
registerLookupRoutes(billsApiRouter)      // GET /:id, GET /resolve/*, GET /drafts, GET /:id/changes
registerEngagementRoutes(billsApiRouter)  // votes, position, comments, note, custom-fields
registerDraftRoutes(billsApiRouter)       // DELETE /:id, POST /draft, POST /:id/link, PATCH /:id/{draft,priority}
registerTextRoutes(billsApiRouter)        // GET /:id/text/:docId
