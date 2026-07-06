import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getMasterList,
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

