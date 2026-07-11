import type { LsEnv } from '../types-legiscan'

type AiAnalyticsEnv = Pick<LsEnv, 'CF_ANALYTICS_TOKEN' | 'CF_ACCOUNT_ID' | 'CF_AIG_GATEWAY'>

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const DAY_MS = 24 * 60 * 60 * 1000

// Cloudflare AI Gateway analytics caps a single query at 4w4d (~32 days), so we
// use a rolling 30-day window. AI has no monthly quota to pace against (unlike
// LegiScan), so a rolling window is the natural framing anyway.
const WINDOW_DAYS = 30

export type AiDailyCount = { date: string; count: number }
export type AiModelCount = { model: string; count: number }

export type AiUsage = {
  total: number             // requests over the window
  windowDays: number        // = WINDOW_DAYS, for the UI label
  daily: AiDailyCount[]      // per-day counts across the window, zero-filled
  topModels: AiModelCount[]  // top 10 models by request count over the window
}

// Fields per the documented example at
// developers.cloudflare.com/ai-gateway/observability/analytics — `count` metric,
// `date`/`model`/`gateway` dimensions, filtered by the datetimeHour range.
const AI_USAGE_QUERY = `
  query AiGatewayUsage($accountTag: String!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        aiGatewayRequestsAdaptiveGroups(
          limit: 10000
          filter: { datetimeHour_geq: $since, datetimeHour_leq: $until }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date model gateway }
        }
      }
    }
  }
`

type RawGroup = { count: number; dimensions: { date: string; model: string; gateway: string } }

/**
 * AI Gateway usage over the last WINDOW_DAYS, read from Cloudflare's GraphQL
 * analytics API (`aiGatewayRequestsAdaptiveGroups`). We already route every Gemini
 * call through the gateway (per-tenant `cf-aig-metadata`), so Cloudflare already
 * has the counts — this reads them back. Uses the same `CF_ANALYTICS_TOKEN`
 * (Account Analytics: Read) as the D1 anomaly watch; scoped to `CF_AIG_GATEWAY`.
 * Throws when unconfigured or on a GraphQL error so the caller can degrade to an
 * "unavailable" panel rather than crash.
 */
export async function fetchAiUsage(env: AiAnalyticsEnv): Promise<AiUsage> {
  if (!env.CF_ANALYTICS_TOKEN) throw new Error('CF_ANALYTICS_TOKEN is unset')
  if (!env.CF_ACCOUNT_ID) throw new Error('CF_ACCOUNT_ID is unset')
  if (!env.CF_AIG_GATEWAY) throw new Error('CF_AIG_GATEWAY is unset')
  const gateway = env.CF_AIG_GATEWAY

  const now = new Date()
  const since = new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS)
  since.setUTCHours(0, 0, 0, 0)

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: AI_USAGE_QUERY,
      variables: { accountTag: env.CF_ACCOUNT_ID, since: since.toISOString(), until: now.toISOString() },
    }),
  })
  if (!res.ok) {
    throw new Error(`AI Gateway analytics query failed: HTTP ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as {
    errors?: { message?: string }[]
    data?: { viewer?: { accounts?: { aiGatewayRequestsAdaptiveGroups?: RawGroup[] }[] } }
  }
  if (body.errors && body.errors.length > 0) {
    throw new Error(`AI Gateway analytics GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`)
  }

  const groups = (body.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups ?? [])
    .filter((g) => g.dimensions.gateway === gateway)

  return rollUp(groups, now, WINDOW_DAYS)
}

/** Pure aggregation of raw gateway groups into the AiUsage shape. Exported for tests. */
export function rollUp(groups: RawGroup[], now: Date, windowDays: number = WINDOW_DAYS): AiUsage {
  const byDate = new Map<string, number>()
  const byModel = new Map<string, number>()
  let total = 0
  for (const g of groups) {
    const c = Number(g.count) || 0
    total += c
    byDate.set(g.dimensions.date, (byDate.get(g.dimensions.date) ?? 0) + c)
    byModel.set(g.dimensions.model, (byModel.get(g.dimensions.model) ?? 0) + c)
  }

  const start = new Date(now.getTime() - (windowDays - 1) * DAY_MS)
  const daily: AiDailyCount[] = []
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(start.getTime() + i * DAY_MS)
    const k = d.toISOString().slice(0, 10)
    daily.push({ date: k, count: byDate.get(k) ?? 0 })
  }

  const topModels = [...byModel.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return { total, windowDays, daily, topModels }
}
