import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listTrackedD1Dbs, fetchDailyRowsRead } from '../../src/lib/d1Analytics'

const env = (over: Record<string, unknown> = {}) =>
  ({ CF_ANALYTICS_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct123', ...over }) as any

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('listTrackedD1Dbs', () => {
  it('returns only dbs whose name starts with floorvote or central-bills', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        success: true,
        result: [
          { uuid: '1', name: 'floorvote-ri' },
          { uuid: '2', name: 'central-bills-legiscan' },
          { uuid: '3', name: 'some-other-db' },
          { uuid: '4', name: 'floorvote-demo' },
        ],
      }),
    )
    const dbs = await listTrackedD1Dbs(env())
    expect(dbs).toEqual([
      { id: '1', name: 'floorvote-ri' },
      { id: '2', name: 'central-bills-legiscan' },
      { id: '4', name: 'floorvote-demo' },
    ])
    // hits the D1 list REST endpoint with bearer token
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toContain('/accounts/acct123/d1/database')
    expect((init.headers as any).Authorization).toBe('Bearer tok')
  })

  it('throws on non-200', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ success: false }, 403))
    await expect(listTrackedD1Dbs(env())).rejects.toThrow()
  })
})

describe('fetchDailyRowsRead', () => {
  it('parses the GraphQL response shape into per-db series', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        data: {
          viewer: {
            accounts: [
              {
                d1AnalyticsAdaptiveGroups: [
                  { dimensions: { date: '2026-06-10' }, sum: { rowsRead: 1000, readQueries: 5 } },
                  { dimensions: { date: '2026-06-11' }, sum: { rowsRead: 2000, readQueries: 7 } },
                ],
              },
            ],
          },
        },
      }),
    )
    const out = await fetchDailyRowsRead(env(), ['db1'], '2026-06-10', '2026-06-11')
    expect(out).toEqual({
      db1: [
        { date: '2026-06-10', rowsRead: 1000 },
        { date: '2026-06-11', rowsRead: 2000 },
      ],
    })
    const [url, init] = fetchMock().mock.calls[0]
    expect(url).toContain('/graphql')
    expect((init.headers as any).Authorization).toBe('Bearer tok')
    const body = JSON.parse(init.body)
    expect(body.variables).toMatchObject({ databaseId: 'db1', since: '2026-06-10', until: '2026-06-11' })
  })

  it('loops over multiple dbIds, one query each', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({
          data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ dimensions: { date: '2026-06-10' }, sum: { rowsRead: 1 } }] }] } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ dimensions: { date: '2026-06-10' }, sum: { rowsRead: 2 } }] }] } },
        }),
      )
    const out = await fetchDailyRowsRead(env(), ['a', 'b'], '2026-06-10', '2026-06-10')
    expect(fetchMock()).toHaveBeenCalledTimes(2)
    expect(out.a[0].rowsRead).toBe(1)
    expect(out.b[0].rowsRead).toBe(2)
  })

  it('throws on non-200', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 500))
    await expect(fetchDailyRowsRead(env(), ['db1'], '2026-06-10', '2026-06-11')).rejects.toThrow()
  })

  it('throws on GraphQL errors array', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'gated field' }] }))
    await expect(fetchDailyRowsRead(env(), ['db1'], '2026-06-10', '2026-06-11')).rejects.toThrow(/gated field/)
  })
})
