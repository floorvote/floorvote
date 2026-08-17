import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { DataTable, Column } from '../components/DataTable'

type TenantHealth = { tenantId: string; name: string; active: boolean; lastBillDeliveredAt: string | null; lastStatsPullAt: string | null; lastSeenAt: string | null; stale: boolean; aiContextPersonalized: boolean }
type StateHealth = { state: string; lastSyncedAt: string | null; stale: boolean }
type OpsData = { tenants: TenantHealth[]; states: StateHealth[]; thresholds: Record<string, number> }

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>{children}</div>
    </div>
  )
}

const tenantCols: Column<TenantHealth>[] = [
  { key: 'name', header: 'Tenant', cell: t => t.name },
  { key: 'bill', header: 'Last bill delivered', cell: t => fmt(t.lastBillDeliveredAt) },
  { key: 'stats', header: 'Last stats pull', cell: t => fmt(t.lastStatsPullAt) },
  { key: 'seen', header: 'Last seen', cell: t => fmt(t.lastSeenAt) },
  {
    key: 'ai',
    header: 'AI instructions',
    cell: t => (
      <span style={{ color: t.aiContextPersonalized ? 'var(--success)' : 'var(--warning)' }}>
        {t.aiContextPersonalized ? 'personalized' : 'generic default'}
      </span>
    ),
  },
]

const stateCols: Column<StateHealth>[] = [
  { key: 'state', header: 'State', cell: s => s.state },
  { key: 'synced', header: 'Last synced', cell: s => fmt(s.lastSyncedAt) },
]

export default function OpsHealth() {
  const [data, setData] = useState<OpsData | null>(null)
  useEffect(() => { api<OpsData>('/admin/dash/ops-health').then(setData) }, [])
  if (!data) return <div style={{ color: 'var(--muted)' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Ops health</h1>

      <Section title="Tenant pipelines">
        <DataTable
          rows={data.tenants}
          columns={tenantCols}
          rowKey={t => t.tenantId}
          rowClassName={t => t.stale ? 'row-stale' : undefined}
        />
      </Section>

      <Section title="State sync staleness">
        <DataTable
          rows={data.states}
          columns={stateCols}
          rowKey={s => s.state}
          rowClassName={s => s.stale ? 'row-stale' : undefined}
        />
      </Section>
    </div>
  )
}
