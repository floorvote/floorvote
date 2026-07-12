import { describe, it, expect } from 'vitest'
import { rollUp, fetchAiUsage } from '../../src/lib/aiGatewayAnalytics'

type SumIn = Partial<{
  cost: number
  cachedTokensIn: number
  cachedTokensOut: number
  uncachedTokensIn: number
  uncachedTokensOut: number
}>

function g(date: string, model: string, count: number, gateway = 'tracker', sum: SumIn = {}) {
  return {
    count,
    sum: { cost: 0, cachedTokensIn: 0, cachedTokensOut: 0, uncachedTokensIn: 0, uncachedTokensOut: 0, ...sum },
    dimensions: { date, model, gateway },
  }
}

describe('rollUp', () => {
  const now = new Date('2026-07-11T12:00:00Z')

  it('totals requests and ranks models over the window', () => {
    const usage = rollUp([
      g('2026-07-01', 'gemini-2.5-flash', 10),
      g('2026-07-11', 'gemini-2.5-flash', 5),
      g('2026-06-20', 'gemini-2.5-pro', 3),
    ], now, 30)
    expect(usage.total).toBe(18)
    expect(usage.windowDays).toBe(30)
    expect(usage.topModels).toEqual([
      { model: 'gemini-2.5-flash', count: 15, cost: 0 },
      { model: 'gemini-2.5-pro', count: 3, cost: 0 },
    ])
  })

  it('sums cost and tokens (cached + uncached) and attributes per-model spend', () => {
    const usage = rollUp([
      g('2026-07-01', 'gemini-2.5-flash', 10, 'tracker', { cost: 1.5, uncachedTokensIn: 1000, uncachedTokensOut: 200 }),
      g('2026-07-11', 'gemini-2.5-flash', 5, 'tracker', { cost: 0.5, cachedTokensIn: 100, cachedTokensOut: 50 }),
      g('2026-06-20', 'gemini-2.5-pro', 3, 'tracker', { cost: 0.25, uncachedTokensIn: 300, uncachedTokensOut: 30 }),
    ], now, 30)
    expect(usage.cost).toBeCloseTo(2.25)
    expect(usage.tokensIn).toBe(1400) // 1000 + 100 + 300
    expect(usage.tokensOut).toBe(280) // 200 + 50 + 30
    expect(usage.topModels).toEqual([
      { model: 'gemini-2.5-flash', count: 15, cost: 2 },
      { model: 'gemini-2.5-pro', count: 3, cost: 0.25 },
    ])
  })

  it('treats groups without a sum block as zero cost/tokens', () => {
    const usage = rollUp(
      [{ count: 4, dimensions: { date: '2026-07-11', model: 'gemini-2.5-flash', gateway: 'tracker' } }],
      now,
      30,
    )
    expect(usage.total).toBe(4)
    expect(usage.cost).toBe(0)
    expect(usage.tokensIn).toBe(0)
    expect(usage.tokensOut).toBe(0)
    expect(usage.topModels).toEqual([{ model: 'gemini-2.5-flash', count: 4, cost: 0 }])
  })

  it('zero-fills the daily series (requests + cost) ending today', () => {
    const usage = rollUp([g('2026-07-11', 'gemini-2.5-flash', 4, 'tracker', { cost: 0.12 })], now, 30)
    expect(usage.daily).toHaveLength(30)
    expect(usage.daily.at(-1)).toEqual({ date: '2026-07-11', count: 4, cost: 0.12 })
    expect(usage.daily.at(0)).toEqual({ date: '2026-06-12', count: 0, cost: 0 })
  })
})

describe('fetchAiUsage config guards', () => {
  it('throws when the analytics token is unset', async () => {
    await expect(fetchAiUsage({ CF_ACCOUNT_ID: 'acct', CF_AIG_GATEWAY: 'tracker' } as any)).rejects.toThrow(/CF_ANALYTICS_TOKEN/)
  })
  it('throws when the gateway slug is unset', async () => {
    await expect(fetchAiUsage({ CF_ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'acct' } as any)).rejects.toThrow(/CF_AIG_GATEWAY/)
  })
})
