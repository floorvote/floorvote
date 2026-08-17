import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { StackedBar } from '../components/StackedBar'
import { DataTable, Column } from '../components/DataTable'
import { EngagementChart } from '../components/EngagementChart'

type D = {
  tenant: { id: string; name: string; states: string[]; aiContextPersonalized: boolean }
  matchTypeBreakdown: { keyword: number; manual: number; null: number }
  textStatusBreakdown: { not_checked: number; no_texts: number; available: number }
  keywordEffectiveness: { keyword: string; billCount: number; pct: number }[]
  crossTenantBills: { billId: number; state: string; billNumber: string; alsoTrackedBy: string[] }[]
}

type ProbeReading = { latencyMs: number | null; ok: boolean | null; statDate: string }

type TenantEngagement = {
  tenant: { id: string; name: string }
  dates: string[]
  metrics: Record<string, (number | null)[]>
  probe?: ProbeReading | null
}

function DbHealth({ probe, threshold = 3000 }: { probe: ProbeReading | null | undefined; threshold?: number }) {
  if (!probe || (probe.latencyMs == null && probe.ok == null)) {
    return (
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>
        DB health: <span style={{ fontWeight: 600 }}>no probe yet</span>
      </span>
    )
  }
  const failed = probe.ok === false
  const slow = !failed && probe.latencyMs != null && probe.latencyMs > threshold
  const label = failed ? 'failed' : slow ? 'slow' : 'ok'
  const color = failed ? 'var(--danger)' : slow ? 'var(--warning)' : 'var(--success)'
  return (
    <span style={{ fontSize: 13, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      DB health:
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
        <span style={{ fontWeight: 600, color }}>{label}</span>
      </span>
      {probe.latencyMs != null && <span>· {probe.latencyMs}ms</span>}
      <span>· {probe.statDate}</span>
    </span>
  )
}

const ENGAGEMENT_METRICS = [
  { key: 'total_members',         title: 'Total Members'         },
  { key: 'active_members_7d',     title: 'Active Members (7d)'   },
  { key: 'active_members_30d',    title: 'Active Members (30d)'  },
  { key: 'votes_cast',            title: 'Votes Cast'            },
  { key: 'comments_written',      title: 'Comments Written'      },
  { key: 'comment_reactions',     title: 'Comment Reactions'     },
  { key: 'positions_set',         title: 'Positions Set'         },
  { key: 'notes_created',         title: 'Notes Created'         },
  { key: 'custom_field_values',   title: 'Custom Field Values'   },
  { key: 'roles_defined',         title: 'Roles Defined'         },
  { key: 'custom_fields_defined', title: 'Custom Fields Defined' },
  { key: 'bills_with_engagement', title: 'Bills with Engagement' },
  { key: 'bills_ai_processed',    title: 'AI Processed Bills'    },
]

export default function TenantDetail() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<D | null>(null)
  const [engagement, setEngagement] = useState<TenantEngagement | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (id) {
      api<D>(`/admin/dash/tenants/${encodeURIComponent(id)}`).then(setData)
      api<TenantEngagement>(`/admin/dash/engagement/tenants/${encodeURIComponent(id)}`).then(setEngagement)
    }
  }, [id])

  async function handleRefresh() {
    if (!id) return
    setRefreshing(true)
    try {
      await api(`/admin/dash/engagement/refresh/${encodeURIComponent(id)}`, { method: 'POST' })
      const fresh = await api<TenantEngagement>(`/admin/dash/engagement/tenants/${encodeURIComponent(id)}`)
      setEngagement(fresh)
    } finally {
      setRefreshing(false)
    }
  }

  if (!data) return <div>Loading…</div>

  const kwCols: Column<{ keyword: string; billCount: number; pct: number }>[] = [
    { key: 'k', header: 'Keyword', cell: r => r.keyword },
    { key: 'c', header: '# bills', cell: r => r.billCount },
    { key: 'p', header: '%', cell: r => `${r.pct.toFixed(1)}%` },
  ]
  const xCols: Column<{ billId: number; state: string; billNumber: string; alsoTrackedBy: string[] }>[] = [
    { key: 'b', header: 'Bill', cell: r => `${r.state} ${r.billNumber}` },
    { key: 'a', header: 'Also tracked by', cell: r => r.alsoTrackedBy.join(', ') },
  ]

  return (
    <div>
      <Link to="/tenants" style={{ fontSize: 13, color: 'var(--muted)' }}>← Tenants</Link>
      <h1 style={{ marginTop: 4, fontSize: 24 }}>{data.tenant.name} <span style={{ color: 'var(--muted)', fontSize: 14, fontWeight: 400 }}>· {data.tenant.id}</span></h1>
      <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 4 }}>{data.tenant.states.join(', ')}</div>
      <div
        style={{
          fontSize: 13,
          marginBottom: 24,
          fontWeight: 600,
          color: data.tenant.aiContextPersonalized ? 'var(--success)' : 'var(--warning)',
        }}
      >
        {data.tenant.aiContextPersonalized ? 'AI instructions: personalized' : 'AI instructions: generic default'}
      </div>

      <h2 style={{ fontSize: 16 }}>Match type</h2>
      <div style={{ marginBottom: 24 }}>
        <StackedBar segments={[
          { label: 'keyword', value: data.matchTypeBreakdown.keyword, color: 'var(--accent)' },
          { label: 'manual', value: data.matchTypeBreakdown.manual, color: '#7c3aed' },
          { label: 'stub', value: data.matchTypeBreakdown.null, color: '#cbd5e1' },
        ]} />
      </div>

      <h2 style={{ fontSize: 16 }}>Text status</h2>
      <div style={{ marginBottom: 24 }}>
        <StackedBar segments={[
          { label: 'available', value: data.textStatusBreakdown.available, color: 'var(--success)' },
          { label: 'no_texts', value: data.textStatusBreakdown.no_texts, color: 'var(--warning)' },
          { label: 'not_checked', value: data.textStatusBreakdown.not_checked, color: '#cbd5e1' },
        ]} />
      </div>

      <h2 style={{ fontSize: 16 }}>Keyword effectiveness</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 24 }}>
        <DataTable rows={data.keywordEffectiveness} columns={kwCols} rowKey={r => r.keyword} empty="No keywords configured." />
      </div>

      <h2 style={{ fontSize: 16 }}>Cross-tenant interest</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}>
        <DataTable rows={data.crossTenantBills} columns={xCols} rowKey={r => r.billId} empty="No overlap with other tenants." />
      </div>

      {engagement && (
        <section style={{ marginTop: 32 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 18, margin: 0 }}>Engagement</h2>
              <DbHealth probe={engagement.probe} />
            </div>
            <button
              onClick={refreshing ? undefined : handleRefresh}
              disabled={refreshing}
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 13,
                background: refreshing ? '#93c5fd' : '#3b82f6',
                color: '#fff', border: 'none', cursor: refreshing ? 'not-allowed' : 'pointer',
              }}
            >
              {refreshing ? 'Refreshing…' : 'Refresh now'}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {ENGAGEMENT_METRICS.map(m => {
              const values = engagement.metrics[m.key] ?? engagement.dates.map(() => null)
              const last = (() => { for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]; return null })()
              return (
                <EngagementChart
                  key={m.key}
                  title={m.title}
                  current={last}
                  series={{
                    dates: engagement.dates,
                    perTenant: [{ id: engagement.tenant.id, name: engagement.tenant.name, values, color: '#1e3a5f' }],
                  }}
                />
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
