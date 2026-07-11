import { describe, it, expect } from 'vitest'
import { rollUp, fetchAiUsage } from '../../src/lib/aiGatewayAnalytics'

function g(date: string, model: string, count: number, gateway = 'tracker') {
  return { count, dimensions: { date, model, gateway } }
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
      { model: 'gemini-2.5-flash', count: 15 },
      { model: 'gemini-2.5-pro', count: 3 },
    ])
  })

  it('zero-fills the daily series ending today', () => {
    const usage = rollUp([g('2026-07-11', 'gemini-2.5-flash', 4)], now, 30)
    expect(usage.daily).toHaveLength(30)
    expect(usage.daily.at(-1)).toEqual({ date: '2026-07-11', count: 4 })
    expect(usage.daily.at(0)).toEqual({ date: '2026-06-12', count: 0 })
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
