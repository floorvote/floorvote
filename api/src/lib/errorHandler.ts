import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { errorText } from '../../../shared/errorText'

/**
 * Hono `onError` handler. Pass HTTPExceptions through with their intended
 * status/body; for anything uncaught, log it (structured) and return a generic
 * 500 so internal error details never leak to the client. Registered via
 * `app.onError(errorHandler)`.
 */
/** Seconds a client should wait before asking again after D1 reports itself overloaded (its budget is a ten-second window). */
export const D1_OVERLOAD_RETRY_AFTER_SECONDS = 10

/** Whether D1 reported itself overloaded (error 7429): its message, on the error or anywhere down its `.cause` chain. */
export function isD1Overload(err: unknown): boolean {
  return errorText(err).includes('D1 DB is overloaded')
}

export function errorHandler(err: Error, c: Context): Response | Promise<Response> {
  if (err instanceof HTTPException) return err.getResponse()
  // Log name + message explicitly: for some runtime errors (notably a D1 backend
  // stall) `err.stack` carries only frames, so logging the object alone leaves
  // Workers Logs with no statement of what actually failed. The cause chain
  // goes with it: Drizzle hangs D1's reason off a "Failed query" wrapper.
  console.error('[unhandled]', `${err.name}: ${errorText(err)}`, err.stack)
  // The overload clears by itself within the window, so it is an answer a client may retry, not a broken request.
  // Nothing caches it: the facets and list caches store only what they computed (a 200).
  if (isD1Overload(err)) {
    return c.json({ error: 'database_overloaded' }, 503, { 'Retry-After': String(D1_OVERLOAD_RETRY_AFTER_SECONDS) })
  }
  return c.json({ error: 'internal_error' }, 500)
}
