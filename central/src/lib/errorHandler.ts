import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * Hono `onError` handler. Pass HTTPExceptions through with their intended
 * status/body; for anything uncaught, log it (structured) and return a generic
 * 500 so internal error details never leak. MIRROR of api/src/lib/errorHandler.ts.
 */
export function errorHandler(err: Error, c: Context): Response | Promise<Response> {
  if (err instanceof HTTPException) return err.getResponse()
  console.error('[unhandled]', err)
  return c.json({ error: 'internal_error' }, 500)
}
