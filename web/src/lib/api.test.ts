import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, ApiError } from './api'
import { TERMS_NOT_ACCEPTED_EVENT } from './appEvents'

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response
}

afterEach(() => { vi.restoreAllMocks() })

describe('apiFetch error handling', () => {
  it('carries the error code alongside the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(403, { error: 'Terms not accepted', code: 'terms_not_accepted' })))
    const err = await apiFetch('/bills').catch(e => e) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(403)
    expect(err.code).toBe('terms_not_accepted')
  })

  it('leaves code undefined when the body carries none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })))
    const err = await apiFetch('/bills').catch(e => e) as ApiError
    expect(err.code).toBeUndefined()
    expect(err.message).toBe('boom')
  })

  // A tab left open when LEGAL_TERMS_UPDATED is bumped starts getting 403s from
  // every route. Without this it would surface as a generic error card.
  it('announces terms_not_accepted so the app can re-check /auth/me', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse(403, { error: 'Terms not accepted', code: 'terms_not_accepted' })))
    const heard = vi.fn()
    window.addEventListener(TERMS_NOT_ACCEPTED_EVENT, heard)
    await apiFetch('/bills').catch(() => {})
    window.removeEventListener(TERMS_NOT_ACCEPTED_EVENT, heard)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for any other failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'Forbidden' })))
    const heard = vi.fn()
    window.addEventListener(TERMS_NOT_ACCEPTED_EVENT, heard)
    await apiFetch('/bills').catch(() => {})
    window.removeEventListener(TERMS_NOT_ACCEPTED_EVENT, heard)
    expect(heard).not.toHaveBeenCalled()
  })

  // D1's overload clears by itself within a ten-second window; the API says when to come back.
  it('carries Retry-After, as milliseconds, on a 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, headers: new Headers({ 'Retry-After': '10' }),
      json: async () => ({ error: 'database_overloaded' }),
    } as Response)))
    const err = await apiFetch('/bills').catch(e => e) as ApiError
    expect(err.status).toBe(503)
    expect(err.retryAfterMs).toBe(10_000)
  })

  it('leaves retryAfterMs undefined when there is no Retry-After, or it is not a number of seconds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, headers: new Headers(), json: async () => ({ error: 'x' }),
    } as Response)))
    expect(((await apiFetch('/bills').catch(e => e)) as ApiError).retryAfterMs).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503, headers: new Headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }), json: async () => ({ error: 'x' }),
    } as Response)))
    expect(((await apiFetch('/bills').catch(e => e)) as ApiError).retryAfterMs).toBeUndefined()
  })
})
