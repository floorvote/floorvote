import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { SummaryCard } from '../components/SummaryCard'
import { DataTable, Column } from '../components/DataTable'

type OverviewData = {
  tenants: { total: number }
  bills: { fullyTracked: number; lightweight: number }
  apiBudget: { used: number; limit: number; pct: number }
}
type Activity = { billId: number; state: string; billNumber: string; changeType: string; oldValue: string | null; newValue: string | null; detail: string | null; detectedAt: string }
type EngagementOverview = {
  tenantCount: number
  asOfDate: string | null
  totals: Record<string, number>
}

const PAGE_SIZE = 50

export default function Overview() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [activity, setActivity] = useState<Activity[]>([])
  const [engagement, setEngagement] = useState<EngagementOverview | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(true)
  const offsetRef = useRef(0)

  useEffect(() => {
    api<OverviewData>('/admin/dash/overview').then(setData)
    api<EngagementOverview>('/admin/dash/engagement/overview').then(setEngagement)
  }, [])

  useEffect(() => {
    async function loadMore() {
      if (loadingRef.current || !hasMoreRef.current) return
      loadingRef.current = true
      setLoading(true)
      try {
        const r = await api<{ entries: Activity[]; hasMore: boolean }>(`/admin/dash/activity?limit=${PAGE_SIZE}&offset=${offsetRef.current}`)
        const entries = r?.entries ?? []
        const hasMore = r?.hasMore ?? false
        setActivity(prev => [...prev, ...entries])
        offsetRef.current += entries.length
        hasMoreRef.current = hasMore
        setHasMore(hasMore)
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
    }
    loadMore()
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) loadMore()
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const budgetAccent = data ? (data.apiBudget.pct > 90 ? 'danger' : data.apiBudget.pct > 70 ? 'warning' : 'normal') : 'normal'

  const columns: Column<Activity>[] = [
    { key: 'bill', header: 'Bill', cell: r => `${r.state} ${r.billNumber}` },
    { key: 'change', header: 'Change', cell: r => r.changeType },
    { key: 'val', header: 'From → To', cell: r => `${r.oldValue ?? '∅'} → ${r.newValue ?? '∅'}` },
    { key: 'when', header: 'When', cell: r => new Date(r.detectedAt).toLocaleString() },
  ]

  return (
    <div>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>Overview</h1>
      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
          <SummaryCard label="Tenants" value={data.tenants.total.toLocaleString()} />
          <SummaryCard
            label="Bills tracked"
            value={data.bills.fullyTracked.toLocaleString()}
            footnote={`+ ${data.bills.lightweight.toLocaleString()} lightweight stubs`}
          />
          <SummaryCard
            label="LegiScan API budget"
            value={`${data.apiBudget.pct.toFixed(1)}%`}
            footnote={`${data.apiBudget.used.toLocaleString()} / ${data.apiBudget.limit.toLocaleString()} this month`}
            accent={budgetAccent}
          />
        </div>
      )}
      {engagement && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
          <SummaryCard
            label="Active members (7d)"
            value={engagement.totals.active_members_7d.toLocaleString()}
            footnote={`${engagement.totals.total_members.toLocaleString()} total members`}
          />
          <SummaryCard
            label="Votes cast (all-time)"
            value={engagement.totals.votes_cast.toLocaleString()}
          />
          <SummaryCard
            label="Bills with engagement"
            value={engagement.totals.bills_with_engagement.toLocaleString()}
          />
        </div>
      )}
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>Recent bill changes</h2>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}>
        <DataTable rows={activity} columns={columns} rowKey={r => `${r.billId}-${r.detectedAt}-${r.changeType}`} />
        <div ref={sentinelRef} style={{ padding: 12, textAlign: 'center', fontSize: 12, color: 'var(--muted)' }}>
          {loading ? 'Loading…' : hasMore ? '' : activity.length === 0 ? '' : 'End of activity'}
        </div>
      </div>
    </div>
  )
}
