import type { LsEnv } from '../types-legiscan'

type AnalyticsEnv = Pick<LsEnv, 'CF_ANALYTICS_TOKEN' | 'CF_ACCOUNT_ID'>

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
const GRAPHQL_ENDPOINT = `${CF_API_BASE}/graphql`

/** Daily rows-read point for one D1 database. */
export type DailyRowsRead = { date: string; rowsRead: number }

function requireToken(env: AnalyticsEnv): string {
  if (!env.CF_ANALYTICS_TOKEN) throw new Error('CF_ANALYTICS_TOKEN is unset')
  return env.CF_ANALYTICS_TOKEN
}

/**
 * List D1 databases on the account, returning only the ones this project tracks
 * (names starting with `floorvote` or `central-bills`). Uses the D1 REST list
 * endpoint with a Bearer token (Account Analytics: Read + D1 read).
 */
export async function listTrackedD1Dbs(env: AnalyticsEnv): Promise<{ id: string; name: string }[]> {
  const token = requireToken(env)
  if (!env.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is unset')
  const url = `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/d1/database?per_page=100`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    throw new Error(`D1 list failed: HTTP ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { success?: boolean; result?: { uuid: string; name: string }[]; errors?: unknown }
  if (!body.success || !Array.isArray(body.result)) {
    throw new Error(`D1 list returned an error: ${JSON.stringify(body.errors ?? body)}`)
  }
  return body.result
    .filter((d) => d.name.startsWith('floorvote') || d.name.startsWith('central-bills'))
    .map((d) => ({ id: d.uuid, name: d.name }))
}

const ROWS_READ_QUERY = `
  query D1RowsRead($accountTag: String!, $databaseId: String!, $since: String!, $until: String!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          limit: 100
          filter: { databaseId: $databaseId, date_geq: $since, date_leq: $until }
          orderBy: [date_ASC]
        ) {
          dimensions { date }
          sum { readQueries rowsRead }
        }
      }
    }
  }
`

/**
 * Fetch daily rowsRead per database over [sinceDate, untilDate] (YYYY-MM-DD).
 * One GraphQL query per database (the analytics API filters by a single
 * databaseId). Throws on non-200 or a GraphQL `errors` array.
 */
export async function fetchDailyRowsRead(
  env: AnalyticsEnv,
  dbIds: string[],
  sinceDate: string,
  untilDate: string,
): Promise<Record<string, DailyRowsRead[]>> {
  const token = requireToken(env)
  if (!env.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is unset')
  const out: Record<string, DailyRowsRead[]> = {}

  for (const databaseId of dbIds) {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: ROWS_READ_QUERY,
        variables: { accountTag: env.CF_ACCOUNT_ID, databaseId, since: sinceDate, until: untilDate },
      }),
    })
    if (!res.ok) {
      throw new Error(`D1 analytics query failed for ${databaseId}: HTTP ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as {
      errors?: { message?: string }[]
      data?: {
        viewer?: {
          accounts?: {
            d1AnalyticsAdaptiveGroups?: { dimensions: { date: string }; sum: { rowsRead: number } }[]
          }[]
        }
      }
    }
    if (body.errors && body.errors.length > 0) {
      throw new Error(`D1 analytics GraphQL error for ${databaseId}: ${body.errors.map((e) => e.message).join('; ')}`)
    }
    const groups = body.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? []
    out[databaseId] = groups.map((g) => ({ date: g.dimensions.date, rowsRead: g.sum.rowsRead }))
  }

  return out
}
