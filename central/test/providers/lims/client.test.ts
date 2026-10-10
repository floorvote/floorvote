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
import details0400Raw from '../../fixtures/lims/details-B26-0400.json?raw'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const d0400 = JSON.parse(details0400Raw) as Record<string, unknown>
const respond = (body: unknown) => mockFetch.mockResolvedValue(new Response(JSON.stringify(body)))

beforeEach(() => mockFetch.mockReset())

function sentRequest(i = 0): { url: string; init: RequestInit } {
  const [input, init] = mockFetch.mock.calls[i]
  return { url: String(input instanceof Request ? input.url : input), init: init ?? {} }
}

describe('LIMS client', () => {
  it('sends the key as a Bearer token and parses JSON', async () => {
    respond([{ councilPeriodId: 26, councilPeriod: '26 (2025-26)', startDate: '2025-01-02T00:00:00', endDate: '2026-12-31T00:00:00' }])
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

  it('reads a null Members answer as no members, as it does BulkData\'s', async () => {
    mockFetch.mockResolvedValue(new Response('null'))
    expect(await getMembers(27, 'k')).toEqual([])
  })

  it('URL-encodes the legislation number', async () => {
    respond(d0400)
    await getLegislationDetails('B26-0400', 'k')
    expect(sentRequest().url).toMatch(/\/LegislationDetails\/B26-0400$/)
  })

  it('accepts details whose number differs only in case or spacing', async () => {
    respond({ ...d0400, legislationNumber: ' b26-0400' })
    expect((await getLegislationDetails('B26-0400', 'k')).legislationNumber).toBe(' b26-0400')
  })

  it('fails closed on a body that isn\'t JSON or isn\'t what the mapping reads', async () => {
    mockFetch.mockResolvedValue(new Response('<html>maintenance</html>'))
    await expect(getCouncilPeriods('k')).rejects.toThrow('CouncilPeriods: the response isn\'t JSON')
    respond({ message: 'An error has occurred.' })
    await expect(getBulkData(1, 26, 'k')).rejects.toThrow('BulkData/1/26: unexpected response (not a list)')
    respond([{ legislationNumber: 'B26-0400', status: 'New', legislationHistory: [null] }])
    await expect(getBulkData(1, 26, 'k')).rejects.toThrow('a history entry of B26-0400')
    mockFetch.mockResolvedValue(new Response('null'))
    await expect(getLegislationDetails('B26-0400', 'k')).rejects.toThrow('no details')
    respond({ ...d0400, legislationNumber: 'B26-0401' })
    await expect(getLegislationDetails('B26-0400', 'k')).rejects.toThrow('the details of "B26-0401"')
    respond({ ...d0400, introducers: [null] })
    await expect(getLegislationDetails('B26-0400', 'k')).rejects.toThrow('introducers isn\'t a list')
    respond([{ id: '194', name: 'Zachary Parker' }])
    await expect(getMembers(26, 'k')).rejects.toThrow('a member without an id and name')
  })

  it('fails closed on details missing a key the mapping reads, and takes null for one', async () => {
    respond({ legislationNumber: 'B26-0400' })
    await expect(getLegislationDetails('B26-0400', 'k')).rejects.toThrow('no status')
    for (const key of ['introducers', 'actions', 'title', 'withdrawnBy', 'mayoralReview', 'congressionalReview']) {
      const { [key]: _dropped, ...rest } = d0400
      respond(rest)
      await expect(getLegislationDetails('B26-0400', 'k'), key).rejects.toThrow(key)
      respond({ ...d0400, [key]: null })
      await expect(getLegislationDetails('B26-0400', 'k'), key).resolves.toBeTruthy()
    }
    // The mapping ignores linkedLegislation, so its shape can't fail a measure.
    respond({ ...d0400, linkedLegislation: { unexpected: true } })
    await expect(getLegislationDetails('B26-0400', 'k')).resolves.toBeTruthy()
  })

  it('fails closed on a BulkData record or history entry missing a key', async () => {
    respond([{ legislationNumber: 'B26-0400', status: 'New' }])
    await expect(getBulkData(1, 26, 'k')).rejects.toThrow('a record without its number, status, or history')
    respond([{ legislationNumber: 'B26-0400', legislationHistory: [] }])
    await expect(getBulkData(1, 26, 'k')).rejects.toThrow('a record without its number, status, or history')
    respond([{ legislationNumber: 'B26-0400', status: 'New', legislationHistory: [{ actionDate: 'Oct 06, 2025', downloadURL: '' }] }])
    await expect(getBulkData(1, 26, 'k')).rejects.toThrow('a history entry of B26-0400')
  })

  it('throws on a non-ok status and logs each outbound attempt', async () => {
    mockFetch.mockResolvedValue(new Response('nope', { status: 401 }))
    const onRequest = vi.fn()
    await expect(getCouncilPeriods('bad', onRequest)).rejects.toThrow('LIMS HTTP 401')
    expect(onRequest).toHaveBeenCalledTimes(1)
  })
})
