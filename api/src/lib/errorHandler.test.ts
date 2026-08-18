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

  it('does not log an HTTPException as unhandled', async () => {
    const spy = captureConsoleError()
    await appWithHandler().request('/teapot')
    expect(spy).not.toHaveBeenCalled()
  })
})
