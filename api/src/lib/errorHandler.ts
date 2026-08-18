import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * Hono `onError` handler. Pass HTTPExceptions through with their intended
 * status/body; for anything uncaught, log it (structured) and return a generic
 * 500 so internal error details never leak to the client. Registered via
 * `app.onError(errorHandler)`.
 */
export function errorHandler(err: Error, c: Context): Response | Promise<Response> {
  if (err instanceof HTTPException) return err.getResponse()
  // Log name + message explicitly: for some runtime errors (notably a D1 backend
  // stall) `err.stack` carries only frames, so logging the object alone leaves
  // Workers Logs with no statement of what actually failed.
  console.error('[unhandled]', `${err.name}: ${err.message}`, err.stack)
  return c.json({ error: 'internal_error' }, 500)
}
