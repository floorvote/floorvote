import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { CumulativeBudgetChart } from '../components/CumulativeBudgetChart'
import { build90DayPoints, computePace } from '../lib/budget'

type LegiBudget = {
  monthToDate: number
  limit: number
  monthDaily: { date: string; calls: number }[]
  topCalls: { callType: string; calls: number }[]
}
type ResendBudget = {
  monthlyUsed: number
  monthlyLimit: number
  dailyUsed: number
  dailyLimit: number | null
  usedAt: string
  last429At: string
  monthDaily: { date: string; monthlyUsed: number }[]
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
  const [resend, setResend] = useState<ResendBudget | null>(null)

  useEffect(() => {
    api<LegiBudget>('/admin/dash/sync/api-budget').then(setLegi)
    api<ResendBudget>('/admin/dash/budget/resend').then(setResend)
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

      <Section title="Resend email">
        {resend && (
          <div style={{ padding: 16 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{resend.monthlyUsed.toLocaleString()}</div>
              <div style={{ color: 'var(--muted)' }}>of {resend.monthlyLimit.toLocaleString()} this month ({pct(resend.monthlyUsed, resend.monthlyLimit)})</div>
            </div>
            {resend.dailyLimit !== null && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>
                Today: {resend.dailyUsed.toLocaleString()} of {resend.dailyLimit.toLocaleString()} ({pct(resend.dailyUsed, resend.dailyLimit)})
              </div>
            )}
            <PaceLine used={resend.monthlyUsed} limit={resend.monthlyLimit} monthElapsed={monthElapsed} />
            <CumulativeBudgetChart
              points={build90DayPoints(resend.monthDaily.map(r => ({ date: r.date, value: r.monthlyUsed })), resend.monthlyLimit, 'snapshots')}
              label="Emails"
            />
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
              Last reading: {resend.usedAt ? new Date(resend.usedAt).toLocaleString() : 'never'}
            </div>
            {resend.last429At && (
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--danger)' }}>
                Throttled (429) at {new Date(resend.last429At).toLocaleString()}
              </div>
            )}
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
              Account-wide across all tenants + central (shared Resend account); no per-tenant split.
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}
