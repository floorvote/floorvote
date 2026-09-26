import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getMasterList,
  getMasterListBySession,
} from '../../src/lib/legiscan'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function okJson(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ status: 'OK', ...data as object })))
}

beforeEach(() => mockFetch.mockReset())

describe('getMasterList', () => {
  it('filters out the session key and returns bill entries', async () => {
    mockFetch.mockResolvedValue(okJson({
      masterlist: {
        session: { session_id: 1 },
        '0': { bill_id: 100, number: 'A1', change_hash: 'abc', title: 'Test', description: 'Desc' },
        '1': { bill_id: 101, number: 'A2', change_hash: 'def', title: 'Test 2', description: 'Desc 2' },
      },
    }))
    const result = await getMasterList('NJ', 'key')
    expect(result).toHaveLength(2)
    expect(result[0].bill_id).toBe(100)
    expect(result[1].bill_id).toBe(101)
  })
})


// legiscanFetch now goes through rateLimitedFetch (1.5 req/sec + 429 retry).
// Its own error handling must be unchanged: LegiScan answers HTTP 200 with an
// error body, so both checks still have to fire.
describe('legiscanFetch error handling', () => {
  it('throws on a non-OK LegiScan status body served with HTTP 200', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'ERROR', alert: { message: 'Invalid API key' } }),
        { status: 200 },
      ),
    )
    await expect(getMasterList('NJ', 'key')).rejects.toThrow(/LegiScan API error/)
  })

  it('throws on a non-ok HTTP status', async () => {
    mockFetch.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(getMasterList('NJ', 'key')).rejects.toThrow('LegiScan HTTP 500')
  })
})


// api_call_log has to record actual egress, so the tracking callback the call
// sites pass must reach the wire and fire only after the request resolves.
describe('legiscan onRequest threading', () => {
  it('invokes the callback after the request, once per call', async () => {
    const order: string[] = []
    mockFetch.mockImplementation(() => {
      order.push('fetch')
      return okJson({ masterlist: { '0': { bill_id: 1, number: 'A1', change_hash: 'h', title: 't', description: 'd' } } })
    })

    const result = await getMasterListBySession(42, 'key', () => order.push('onRequest'))

    expect(result).toHaveLength(1)
    expect(order).toEqual(['fetch', 'onRequest'])
  })

  it('still invokes the callback when LegiScan answers with an error body', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: 'ERROR', alert: { message: 'nope' } }), { status: 200 }),
    )
    const onRequest = vi.fn()

    // The request did go out, so it is still logged — the error is LegiScan's
    // answer, not a failure to reach it.
    await expect(getMasterList('NJ', 'key', onRequest)).rejects.toThrow(/LegiScan API error/)
    expect(onRequest).toHaveBeenCalledTimes(1)
  })
})
