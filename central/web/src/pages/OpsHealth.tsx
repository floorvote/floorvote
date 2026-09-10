import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { DataTable, Column } from '../components/DataTable'

type TenantHealth = {
  tenantId: string
  name: string
  active: boolean
  lastBillDeliveredAt: string | null
  lastStatsPullAt: string | null
  lastSeenAt: string | null
  stale: boolean
  problems: string[]
  aiContextPersonalized: boolean
  stalledAi: number
  stalledAiOldestHours: number
}
type StateHealth = { state: string; lastSyncedAt: string | null; stale: boolean }
type OpsData = { tenants: TenantHealth[]; states: StateHealth[]; thresholds: Record<string, number> }

/** Absolute time for a title/tooltip — hovering the relative text still gives the exact moment. */
function absolute(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : ''
}

/** "just now" / "N min ago" / "N hours ago" / "N days ago" — a non-expert reads
 *  this without doing timestamp math themselves. */
function relative(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2>
      {caption && <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 8px' }}>{caption}</p>}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>{children}</div>
    </div>
  )
}

const tenantCols: Column<TenantHealth>[] = [
  { key: 'name', header: 'Tenant', cell: t => t.name },
  {
    key: 'status',
    header: 'Status',
    cell: t =>
      t.problems.length === 0
        ? <span style={{ color: 'var(--success)' }}>OK</span>
        : (
          <span style={{ color: 'var(--warning)' }}>
            {t.problems.map((p, i) => <div key={i}>{p}</div>)}
          </span>
        ),
  },
  { key: 'bill', header: 'Last bill delivered', cell: t => <span title={absolute(t.lastBillDeliveredAt)}>{relative(t.lastBillDeliveredAt)}</span> },
  { key: 'stats', header: 'Last stats pull', cell: t => <span title={absolute(t.lastStatsPullAt)}>{relative(t.lastStatsPullAt)}</span> },
  {
    key: 'stalled',
    header: 'AI stalled',
    cell: t => {
      const text = t.stalledAi > 0 ? `${t.stalledAi} (oldest ${t.stalledAiOldestHours}h)` : '0'
      // Colored only when the sweep's age crossed into a real problem, not
      // merely because the count is nonzero — a fresh outage mid-recovery
      // isn't one.
      const isProblem = t.problems.some(p => p.includes('stuck on AI analysis'))
      return <span style={{ color: isProblem ? 'var(--warning)' : undefined }}>{text}</span>
    },
  },
  { key: 'seen', header: 'Last seen', cell: t => <span title={absolute(t.lastSeenAt)}>{relative(t.lastSeenAt)}</span> },
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
  { key: 'synced', header: 'Last synced', cell: s => <span title={absolute(s.lastSyncedAt)}>{relative(s.lastSyncedAt)}</span> },
]

export default function OpsHealth() {
  const [data, setData] = useState<OpsData | null>(null)
  useEffect(() => { api<OpsData>('/admin/dash/ops-health').then(setData) }, [])
  if (!data) return <div style={{ color: 'var(--muted)' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Ops health</h1>

      <Section
        title="Tenant pipelines"
        caption="A tenant showing OK needs nothing from you; a tinted row means something needs a look — read its Status column for what."
      >
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
