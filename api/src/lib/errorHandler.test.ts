import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { errorHandler } from './errorHandler'

function appWithHandler() {
  const app = new Hono()
  app.onError(errorHandler)
  app.get('/boom', () => { throw new Error('kaboom internal detail') })
  // Named/messaged like the 2026-08-17 D1 stall, whose Workers Logs entries
  // carried a bare stack and no statement of what failed.
  app.get('/stall', () => {
    const err = new Error('D1_ERROR: Network connection lost.')
    err.name = 'Error'
    throw err
  })
  // Shaped like Drizzle's wrapper of a D1 error: the wrapper names the SQL, and D1's reason hangs off `.cause`.
  app.get('/wrapped', () => {
    throw new Error('Failed query: select 1', { cause: new Error('D1 DB is overloaded. Too many resources consumed within a 10 second window.') })
  })
  app.get('/overloaded', () => {
    throw new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.: SQLITE_ERROR')
  })
  app.get('/overloaded-wrapped', () => {
    throw new Error('Failed query: select 1', { cause: new Error('D1 DB is overloaded. Too many resources consumed within a 10 second window.') })
  })
  app.get('/teapot', () => { throw new HTTPException(418, { message: 'no coffee' }) })
  return app
}

/** Silence the log while capturing it — these routes throw on purpose. */
function captureConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

afterEach(() => { vi.restoreAllMocks() })

describe('errorHandler', () => {
  it('returns a structured 500 for uncaught errors without leaking the message', async () => {
    captureConsoleError()
    const res = await appWithHandler().request('/boom')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('passes through an HTTPException with its own status', async () => {
    const res = await appWithHandler().request('/teapot')
    expect(res.status).toBe(418)
  })

  // The point of the change: logging the Error object alone left Workers Logs
  // with frames and nothing else, because some runtime errors carry a stack
  // that does not repeat the message. The name and message must appear as
  // their own logged string, not merely somewhere inside the error object.
  it('logs the error name and message as a statement, not just the object', async () => {
    const spy = captureConsoleError()
    await appWithHandler().request('/stall')
    expect(spy).toHaveBeenCalledTimes(1)
    const args = spy.mock.calls[0]
    expect(args[0]).toBe('[unhandled]')
    expect(args[1]).toBe('Error: D1_ERROR: Network connection lost.')
    // ...and the stack still travels with it, so the frames are not lost.
    expect(String(args[2])).toContain('D1_ERROR: Network connection lost.')
  })

  // A failed query logged only "Failed query: <sql>" on every request a D1 overload took down, so the reason
  // (the database's 10-second budget spent) had to be found by reproducing it.
  it('logs the reason down the cause chain, not only the wrapper', async () => {
    const spy = captureConsoleError()
    await appWithHandler().request('/wrapped')
    expect(spy.mock.calls[0][1]).toBe(
      'Error: Failed query: select 1 | caused by: D1 DB is overloaded. Too many resources consumed within a 10 second window.',
    )
  })

  it('does not log an HTTPException as unhandled', async () => {
    const spy = captureConsoleError()
    await appWithHandler().request('/teapot')
    expect(spy).not.toHaveBeenCalled()
  })

  // D1 answers a database that spent its CPU budget for the ten-second window (error 7429) with this message. It
  // clears by itself, so the answer is a 503 a client may retry after the interval, not a broken 500.
  it('answers D1\'s overload with a 503, Retry-After: 10, and a body naming it', async () => {
    captureConsoleError()
    const res = await appWithHandler().request('/overloaded')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('10')
    expect(await res.json()).toMatchObject({ error: 'database_overloaded' })
  })

  it('finds the overload down the cause chain, where Drizzle hangs it', async () => {
    captureConsoleError()
    const res = await appWithHandler().request('/overloaded-wrapped')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('10')
  })

  it('still logs an overload as a statement', async () => {
    const spy = captureConsoleError()
    await appWithHandler().request('/overloaded-wrapped')
    expect(spy.mock.calls[0][1]).toContain('D1 DB is overloaded')
  })

  it('keeps a 500 for other database errors, with no Retry-After', async () => {
    captureConsoleError()
    const res = await appWithHandler().request('/stall')
    expect(res.status).toBe(500)
    expect(res.headers.get('Retry-After')).toBeNull()
  })
})
