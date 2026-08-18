import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let responder: () => Promise<unknown> = async () => ({ ok: true })
const calls: string[] = []

vi.mock('./api', () => {
  class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
      this.name = 'ApiError'
    }
  }
  return { ApiError, apiFetch: async (p: string) => { calls.push(p); return responder() } }
})

import { apiFetchForLoader } from './loaderFetch'
import { ApiError } from './api'
import * as retryFetchModule from './retryFetch'
import { createProgressBox, type RetryOptions } from './retryFetch'

beforeEach(() => { calls.length = 0; responder = async () => ({ ok: true }) })
afterEach(() => { vi.restoreAllMocks() })

describe('apiFetchForLoader', () => {
  it('returns data on success', async () => {
    await expect(apiFetchForLoader('/feed')).resolves.toEqual({ ok: true })
  })

  it('throws a redirect Response to /login on 401, without retrying', async () => {
    responder = async () => { throw new ApiError(401, 'Not authenticated') }
    await expect(apiFetchForLoader('/feed')).rejects.toBeInstanceOf(Response)
    expect(calls).toHaveLength(1)
  })

  it('propagates a non-retryable, non-401 error unchanged', async () => {
    responder = async () => { throw new ApiError(404, 'Not found') }
    await expect(apiFetchForLoader('/feed')).rejects.toBeInstanceOf(ApiError)
    await expect(apiFetchForLoader('/feed')).rejects.toMatchObject({ status: 404 })
  })

  // The three tests above pass equally well against the pre-Task-3 implementation
  // (a bare apiFetch call), since none of them exercise a 5xx/retryable path. This
  // test pins the actual wiring change: apiFetchForLoader must delegate to
  // retryFetch (not call apiFetch directly), forwarding the caller's options
  // through verbatim — including `progress`, which Tasks 4/5 rely on to drive
  // LoadingState's retry countdown. Asserting against the same `opts` object
  // (rather than a literal with just two of its keys) catches an implementation
  // that reconstructs the options field-by-field and silently drops `progress`.
  it('routes the request through retryFetch, forwarding options', async () => {
    const spy = vi.spyOn(retryFetchModule, 'retryFetch')
    const signal = new AbortController().signal
    const opts: RetryOptions = { deadlineMs: 1234, signal, progress: createProgressBox() }
    await apiFetchForLoader('/feed', opts)
    expect(spy).toHaveBeenCalledWith('/feed', opts)
  })
})
