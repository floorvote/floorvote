// The shared test setup (test/setup.ts): the schema, the network guard, and
// the draining of background work.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { takeBlockedRequests } from './networkGuard'
import { stubFetch } from './helpers'

describe('schema', () => {
  it('is in place before the first test, with no call from the test', async () => {
    const row = await env.DB.prepare('SELECT count(*) AS n FROM users').first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  it('has the whole migration list applied, not just the first', async () => {
    // notifications arrives in 0085; a schema that stopped early has no such table.
    const row = await env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").first<{ n: number }>()
    expect(row?.n).toBe(1)
  })
})

describe('network guard', () => {
  it('refuses an unstubbed request and names the method and URL', async () => {
    await expect(fetch('https://api.resend.com/emails', { method: 'POST' }))
      .rejects.toThrow('POST https://api.resend.com/emails')
    expect(takeBlockedRequests()).toEqual(['POST https://api.resend.com/emails'])
  })

  it('names the URL of a Request object, too', async () => {
    await expect(fetch(new Request('https://central.test/api/tenants/register', { method: 'POST' })))
      .rejects.toThrow('POST https://central.test/api/tenants/register')
    takeBlockedRequests()
  })

  it('lets a per-test stub answer instead', async () => {
    const stub = stubFetch(() => new Response('stubbed', { status: 201 }))
    const res = await fetch('https://api.resend.com/emails', { method: 'POST' })
    expect(res.status).toBe(201)
    expect(stub).toHaveBeenCalledTimes(1)
    expect(takeBlockedRequests()).toEqual([])
  })

  it('lets vi.spyOn(globalThis, "fetch") answer instead', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('spied'))
    expect(await (await fetch('https://central.test/x')).text()).toBe('spied')
    expect(takeBlockedRequests()).toEqual([])
  })

  describe('after a test undoes its stub', () => {
    afterEach(() => { takeBlockedRequests() })

    it('is back to refusing, not to the real network', async () => {
      stubFetch()
      vi.unstubAllGlobals()
      await expect(fetch('https://central.test/x')).rejects.toThrow('GET https://central.test/x')
    })
  })

  // The caller of fetch can catch the guard's error, as production code does for
  // email and central calls. The test must fail anyway: `it.fails` passes only
  // if the afterEach check rejects it.
  it.fails('fails a test even when the code under test swallows the error', async () => {
    try {
      await fetch('https://api.resend.com/emails', { method: 'POST' })
    } catch {
      // swallowed, as `sendSignInLinkLogged` does
    }
  })
})

describe('background work', () => {
  it('a rejected ctx.waitUntil promise fails the test that waits on it', async () => {
    const ctx = createExecutionContext()
    ctx.waitUntil(Promise.reject(new Error('background failure')))
    await expect(waitOnExecutionContext(ctx)).rejects.toThrow('background failure')
  })
})
