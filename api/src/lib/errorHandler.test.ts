import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { errorHandler } from './errorHandler'

function appWithHandler() {
  const app = new Hono()
  app.onError(errorHandler)
  app.get('/boom', () => { throw new Error('kaboom internal detail') })
  app.get('/teapot', () => { throw new HTTPException(418, { message: 'no coffee' }) })
  return app
}

describe('errorHandler', () => {
  it('returns a structured 500 for uncaught errors without leaking the message', async () => {
    const res = await appWithHandler().request('/boom')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })

  it('passes through an HTTPException with its own status', async () => {
    const res = await appWithHandler().request('/teapot')
    expect(res.status).toBe(418)
  })
})
