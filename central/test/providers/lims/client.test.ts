import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unpaced, so each call doesn't cost the test a second (rateLimitedFetch has its own tests).
vi.mock('../../../src/lib/rateLimitedFetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit | undefined, opts: { onRequest?: () => void }) => {
    const res = await fetch(url, init)
    opts.onRequest?.()
    return res
  },
}))

import { getBulkData, getLegislationDetails, getCouncilPeriods, getMembers } from '../../../src/providers/lims/client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

function sentRequest(i = 0): { url: string; init: RequestInit } {
  const [input, init] = mockFetch.mock.calls[i]
  return { url: String(input instanceof Request ? input.url : input), init: init ?? {} }
}

describe('LIMS client', () => {
  it('sends the key as a Bearer token and parses JSON', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }])))
    const periods = await getCouncilPeriods('dev-key')
    expect(periods[0].councilPeriodId).toBe(26)
    const { url, init } = sentRequest()
    expect(url).toBe('https://lims.dccouncil.gov/api/v2/PublicData/CouncilPeriods')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer dev-key')
  })

  it('POSTs BulkData and treats a null body as an empty list', async () => {
    mockFetch.mockResolvedValue(new Response('null'))
    expect(await getBulkData(1, 26, 'k')).toEqual([])
    const { url, init } = sentRequest()
    expect(url).toMatch(/\/BulkData\/1\/26$/)
    expect(init.method).toBe('POST')
  })

  it('URL-encodes the legislation number', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ legislationNumber: 'B26-0400' })))
    await getLegislationDetails('B26-0400', 'k')
    expect(sentRequest().url).toMatch(/\/LegislationDetails\/B26-0400$/)
  })

  it('accepts details whose number differs only in case or spacing', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ legislationNumber: ' b26-0400', actions: null })))
    expect((await getLegislationDetails('B26-0400', 'k')).legislationNumber).toBe(' b26-0400')
  })

  it('fails closed on a body that isn\'t JSON or isn\'t what the mapping reads', async () => {
    mockFetch.mockResolvedValue(new Response('<html>maintenance</html>'))
    await expect(getCouncilPeriods('k')).rejects.toThrow('CouncilPeriods: the response isn\'t JSON')
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ message: 'An error has occurred.' })))
    await expect(getBulkData(1, 26, 'k')).rejects.toThrow('BulkData/1/26: unexpected response (not a list)')
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ legislationNumber: 'B26-0400', legislationHistory: [null] }])))
    await expect(getBulkData(1, 26, 'k')).rejects.toThrow('a history entry of B26-0400')
    mockFetch.mockResolvedValue(new Response('null'))
    await expect(getLegislationDetails('B26-0400', 'k')).rejects.toThrow('no details')
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ legislationNumber: 'B26-0401' })))
    await expect(getLegislationDetails('B26-0400', 'k')).rejects.toThrow('the details of "B26-0401"')
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ legislationNumber: 'B26-0400', introducers: [null] })))
    await expect(getLegislationDetails('B26-0400', 'k')).rejects.toThrow('introducers isn\'t a list')
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ id: '194', name: 'Zachary Parker' }])))
    await expect(getMembers(26, 'k')).rejects.toThrow('a member without an id and name')
  })

  it('throws on a non-ok status and logs each outbound attempt', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 401 }))
    const onRequest = vi.fn()
    await expect(getCouncilPeriods('bad', onRequest)).rejects.toThrow('LIMS HTTP 401')
    expect(onRequest).toHaveBeenCalledTimes(1)
  })
})
