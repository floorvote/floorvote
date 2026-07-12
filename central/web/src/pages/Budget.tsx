import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { CumulativeBudgetChart } from '../components/CumulativeBudgetChart'
import { DailyCostChart } from '../components/DailyCostChart'
import { build90DayPoints, computePace } from '../lib/budget'

type LegiBudget = {
  monthToDate: number
  limit: number
  monthDaily: { date: string; calls: number }[]
  topCalls: { callType: string; calls: number }[]
}

type AiBudget =
  | {
      available: true
      total: number
      cost: number
      tokensIn: number
      tokensOut: number
      windowDays: number
      daily: { date: string; count: number; cost: number }[]
      topModels: { model: string; count: number; cost: number }[]
    }
  | { available: false; reason: string }

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>{children}</div>
    </div>
  )
}

function pct(used: number, limit: number): string {
  if (!limit) return '—'
  return `${((used / limit) * 100).toFixed(1)}%`
}

function PaceLine({ used, limit, monthElapsed }: { used: number; limit: number; monthElapsed: number }) {
  const { pacePct, projected } = computePace({ used, limit, monthElapsed })
  const over = pacePct > 100
  return (
    <div style={{ marginTop: 8, fontSize: 12, color: over ? 'var(--danger)' : 'var(--muted)' }}>
      using {pacePct}% of maximum pace · projected ~{projected.toLocaleString()}/mo
    </div>
  )
}

export default function Budget() {
  const [legi, setLegi] = useState<LegiBudget | null>(null)
  const [ai, setAi] = useState<AiBudget | null>(null)

  useEffect(() => {
    api<LegiBudget>('/admin/dash/sync/api-budget').then(setLegi)
    api<AiBudget>('/admin/dash/budget/ai').then(setAi)
  }, [])

  const now = new Date()
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  const monthElapsed = (now.getTime() - monthStart) / (monthEnd - monthStart)

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Budget</h1>

      <Section title="LegiScan API">
        {legi && (
          <div style={{ padding: 16 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{legi.monthToDate.toLocaleString()}</div>
              <div style={{ color: 'var(--muted)' }}>of {legi.limit.toLocaleString()} this month ({pct(legi.monthToDate, legi.limit)})</div>
            </div>
            <PaceLine used={legi.monthToDate} limit={legi.limit} monthElapsed={monthElapsed} />
            <CumulativeBudgetChart
              points={build90DayPoints(legi.monthDaily.map(d => ({ date: d.date, value: d.calls })), legi.limit, 'increments')}
              label="API calls"
            />
            <div style={{ marginTop: 16 }}>
              <strong style={{ fontSize: 13 }}>Top call types (MTD)</strong>
              <ul style={{ marginTop: 4, fontSize: 13 }}>
                {legi.topCalls.map(r => <li key={r.callType}>{r.callType}: {r.calls.toLocaleString()}</li>)}
              </ul>
            </div>
          </div>
        )}
      </Section>

      <Section title="AI usage">
        {ai && (ai.available ? (
          <div style={{ padding: 16 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{usd(ai.cost)}</div>
              <div style={{ color: 'var(--muted)' }}>estimated Gemini spend · last {ai.windowDays} days (via Cloudflare AI Gateway)</div>
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
              {ai.total.toLocaleString()} requests · {(ai.tokensIn + ai.tokensOut).toLocaleString()} tokens ({ai.tokensIn.toLocaleString()} in / {ai.tokensOut.toLocaleString()} out)
            </div>
            <DailyCostChart
              points={ai.daily.map(d => ({ date: d.date, value: d.cost }))}
              label="Spend"
              valueFormat={usd}
            />
            {ai.topModels.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <strong style={{ fontSize: 13 }}>Top models (last {ai.windowDays}d)</strong>
                <ul style={{ marginTop: 4, fontSize: 13 }}>
                  {ai.topModels.map(r => <li key={r.model}>{r.model}: {r.count.toLocaleString()} · {usd(r.cost)}</li>)}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>
            AI usage unavailable — {ai.reason}. Requires <code>CF_AIG_GATEWAY</code> on central plus a <code>CF_ANALYTICS_TOKEN</code> with AI Gateway analytics access.
          </div>
        ))}
      </Section>
    </div>
  )
}
