import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getBulkData, getLegislationDetails, getCouncilPeriods } from '../../src/lib/lims'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

function sentRequest(i = 0): { url: string; init: RequestInit } {
  const [input, init] = mockFetch.mock.calls[i]
  return { url: String(input instanceof Request ? input.url : input), init: init ?? {} }
}

describe('LIMS client', () => {
  it('sends the key as a Bearer token and parses JSON', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ councilPeriodId: 26 }])))
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

  it('throws on a non-ok status and logs each outbound attempt', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 401 }))
    const onRequest = vi.fn()
    await expect(getCouncilPeriods('bad', onRequest)).rejects.toThrow('LIMS HTTP 401')
    expect(onRequest).toHaveBeenCalledTimes(1)
  })
})
