import type { LsEnv } from '../types-legiscan'

type AiAnalyticsEnv = Pick<LsEnv, 'CF_ANALYTICS_TOKEN' | 'CF_ACCOUNT_ID' | 'CF_AIG_GATEWAY'>

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const DAY_MS = 24 * 60 * 60 * 1000

// Cloudflare AI Gateway analytics caps a single query at 4w4d (~32 days), so we
// use a rolling 30-day window. AI has no monthly quota to pace against (unlike
// LegiScan), so a rolling window is the natural framing anyway.
const WINDOW_DAYS = 30

export type AiDailyPoint = { date: string; count: number; cost: number }
export type AiModelStat = { model: string; count: number; cost: number }

export type AiUsage = {
  total: number             // requests over the window
  cost: number              // estimated spend (USD) over the window
  tokensIn: number          // input tokens (cached + uncached) over the window
  tokensOut: number         // output tokens (cached + uncached) over the window
  windowDays: number        // = WINDOW_DAYS, for the UI label
  daily: AiDailyPoint[]      // per-day requests + spend across the window, zero-filled
  topModels: AiModelStat[]   // top 10 models by request count, with per-model spend
}

// `count`/`date`/`model`/`gateway` are the documented request-metric fields; the
// `sum { … }` cost + token fields (cost in USD, cached/uncached token counts) are
// undocumented but confirmed present on aiGatewayRequestsAdaptiveGroups via a live
// query — there is no aggregate `tokensIn`/`tokens` field, only the cached/uncached
// split, so we add the two halves per direction below.
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
          sum { cost cachedTokensIn cachedTokensOut uncachedTokensIn uncachedTokensOut }
          dimensions { date model gateway }
        }
      }
    }
  }
`

type RawSum = {
  cost: number
  cachedTokensIn: number
  cachedTokensOut: number
  uncachedTokensIn: number
  uncachedTokensOut: number
}
type RawGroup = {
  count: number
  sum?: RawSum
  dimensions: { date: string; model: string; gateway: string }
}

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
  const byDateCost = new Map<string, number>()
  const byModel = new Map<string, { count: number; cost: number }>()
  let total = 0
  let cost = 0
  let tokensIn = 0
  let tokensOut = 0
  for (const g of groups) {
    const c = Number(g.count) || 0
    const s = g.sum
    const gc = Number(s?.cost) || 0
    const gin = (Number(s?.cachedTokensIn) || 0) + (Number(s?.uncachedTokensIn) || 0)
    const gout = (Number(s?.cachedTokensOut) || 0) + (Number(s?.uncachedTokensOut) || 0)
    total += c
    cost += gc
    tokensIn += gin
    tokensOut += gout
    byDate.set(g.dimensions.date, (byDate.get(g.dimensions.date) ?? 0) + c)
    byDateCost.set(g.dimensions.date, (byDateCost.get(g.dimensions.date) ?? 0) + gc)
    const m = byModel.get(g.dimensions.model) ?? { count: 0, cost: 0 }
    m.count += c
    m.cost += gc
    byModel.set(g.dimensions.model, m)
  }

  const start = new Date(now.getTime() - (windowDays - 1) * DAY_MS)
  const daily: AiDailyPoint[] = []
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(start.getTime() + i * DAY_MS)
    const k = d.toISOString().slice(0, 10)
    daily.push({ date: k, count: byDate.get(k) ?? 0, cost: byDateCost.get(k) ?? 0 })
  }

  const topModels = [...byModel.entries()]
    .map(([model, v]) => ({ model, count: v.count, cost: v.cost }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return { total, cost, tokensIn, tokensOut, windowDays, daily, topModels }
}
