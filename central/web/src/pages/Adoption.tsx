import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { EngagementChart } from '../components/EngagementChart'
import { tenantColor } from '../lib/seriesColors'

const HIDDEN_KEY = 'adoption.hiddenTenants'
const EXCLUDE_INTERNAL_KEY = 'adoption.excludeInternal'

// Metrics the server offers an "internal users excluded" variant for (`<key>__excl`).
const EXCLUDABLE = new Set([
  'total_members', 'active_members_7d', 'active_members_30d',
  'votes_cast', 'comments_written', 'comment_reactions',
])

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch { /* ignore malformed storage */ }
  return new Set()
}

function loadExcludeInternal(): boolean {
  try { return localStorage.getItem(EXCLUDE_INTERNAL_KEY) === '1' } catch { return false }
}

type Series = {
  tenants: { id: string; name: string }[]
  dates: string[]
  metrics: Record<string, Record<string, (number | null)[]>>
}

const METRIC_TITLES: { key: string; title: string; group: string }[] = [
  { key: 'total_members',         title: 'Total Members',         group: 'Membership' },
  { key: 'active_members_7d',     title: 'Active Members (7d)',   group: 'Membership' },
  { key: 'active_members_30d',    title: 'Active Members (30d)',  group: 'Membership' },
  { key: 'votes_cast',            title: 'Votes Cast',            group: 'Member engagement' },
  { key: 'comments_written',      title: 'Comments Written',      group: 'Member engagement' },
  { key: 'comment_reactions',     title: 'Comment Reactions',     group: 'Member engagement' },
  { key: 'positions_set',         title: 'Positions Set',         group: 'Admin engagement' },
  { key: 'notes_created',         title: 'Notes Created',         group: 'Admin engagement' },
  { key: 'custom_field_values',   title: 'Custom Field Values',   group: 'Admin engagement' },
  { key: 'roles_defined',         title: 'Roles Defined',         group: 'Setup maturity' },
  { key: 'custom_fields_defined', title: 'Custom Fields Defined', group: 'Setup maturity' },
  { key: 'bills_with_engagement', title: 'Bills with Engagement', group: 'Setup maturity' },
  { key: 'bills_ai_processed',    title: 'AI Processed Bills',    group: 'AI coverage' },
]

function sumDown(arrays: (number | null)[][]): (number | null)[] {
  if (arrays.length === 0) return []
  const len = arrays[0].length
  const out: (number | null)[] = []
  for (let i = 0; i < len; i++) {
    let sum = 0
    let any = false
    for (const a of arrays) {
      const v = a[i]
      if (v !== null && v !== undefined) {
        sum += v
        any = true
      }
    }
    out.push(any ? sum : null)
  }
  return out
}

function lastValue(arr: (number | null)[]): number | null {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null) return arr[i]
  return null
}

export default function Adoption() {
  const [series, setSeries] = useState<Series | null>(null)
  const [days, setDays] = useState<number>(90)
  const [downloading, setDownloading] = useState(false)
  const [format, setFormat] = useState<'csv' | 'json'>('csv')
  const [hidden, setHidden] = useState<Set<string>>(loadHidden)
  const [excludeInternal, setExcludeInternal] = useState<boolean>(loadExcludeInternal)
  const [excludeDomains, setExcludeDomains] = useState<string[]>([])
  const [domainDraft, setDomainDraft] = useState('')
  const [savingDomains, setSavingDomains] = useState(false)

  useEffect(() => {
    api<Series>(`/admin/dash/engagement/series?days=${days}`).then(setSeries)
  }, [days])

  useEffect(() => {
    api<{ domains: string[] }>('/admin/dash/engagement/exclude-config')
      .then(d => { setExcludeDomains(d.domains); setDomainDraft(d.domains.join(', ')) })
      .catch(() => { /* leave empty on failure */ })
  }, [])

  useEffect(() => {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])) } catch { /* ignore */ }
  }, [hidden])

  useEffect(() => {
    try { localStorage.setItem(EXCLUDE_INTERNAL_KEY, excludeInternal ? '1' : '0') } catch { /* ignore */ }
  }, [excludeInternal])

  async function saveDomains() {
    setSavingDomains(true)
    try {
      const parsed = domainDraft.split(',').map(s => s.trim()).filter(Boolean)
      const d = await api<{ domains: string[] }>('/admin/dash/engagement/exclude-config', {
        method: 'PUT',
        body: JSON.stringify({ domains: parsed }),
      })
      setExcludeDomains(d.domains)
      setDomainDraft(d.domains.join(', '))
    } finally {
      setSavingDomains(false)
    }
  }

  // Stable color per tenant, keyed off the full tenant list order so a tenant's
  // color stays put even when others are toggled off.
  const colorById = useMemo(() => {
    const map: Record<string, string> = {}
    series?.tenants.forEach((t, i) => { map[t.id] = tenantColor(i) })
    return map
  }, [series])

  function toggleTenant(id: string) {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function handleDownload() {
    setDownloading(true)
    try {
      const url = `/admin/dash/engagement/export?format=${format}&days=${days}`
      // Browser-native download: fetch with credentials, then create blob link
      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) throw new Error(`Export failed (${res.status})`)
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      const today = new Date().toISOString().slice(0, 10)
      a.download = `engagement-stats-${today}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(blobUrl)
    } finally {
      setDownloading(false)
    }
  }

  if (!series) return <div style={{ color: 'var(--muted)' }}>Loading…</div>

  const groups = Array.from(new Set(METRIC_TITLES.map(m => m.group)))
  const tenantsForChart = series.tenants.filter(t => !hidden.has(t.id))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <h1 style={{ marginTop: 0, fontSize: 24 }}>Adoption</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <select
            value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}
          >
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 365 days</option>
          </select>
          <div
            role="button"
            onClick={downloading ? undefined : handleDownload}
            style={{
              borderRadius: 6, padding: '8px 14px',
              background: downloading ? '#93c5fd' : '#3b82f6',
              color: '#fff', cursor: downloading ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 500, lineHeight: 1.4,
              display: 'flex', alignItems: 'center', gap: 5, userSelect: 'none',
            }}
          >
            {downloading ? 'Downloading…' : (
              <>
                Download adoption stats as
                <select
                  value={format}
                  onClick={e => e.stopPropagation()}
                  onChange={e => { e.stopPropagation(); setFormat(e.target.value as 'csv' | 'json') }}
                  style={{
                    background: 'transparent', color: '#fff', border: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.6)',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    padding: 0, outline: 'none', fontFamily: 'inherit',
                  }}
                >
                  <option value="csv" style={{ color: '#000' }}>CSV</option>
                  <option value="json" style={{ color: '#000' }}>JSON</option>
                </select>
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 24 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginRight: 4 }}>Tenants:</span>
        {series.tenants.map(t => {
          const on = !hidden.has(t.id)
          const c = colorById[t.id]
          return (
            <button
              key={t.id}
              onClick={() => toggleTenant(t.id)}
              title={on ? `Hide ${t.name}` : `Show ${t.name}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${on ? c : 'var(--border)'}`,
                background: on ? `${c}14` : 'transparent',
                color: on ? 'var(--fg)' : 'var(--muted)',
                fontSize: 12, lineHeight: 1.4,
              }}
            >
              <span style={{
                width: 10, height: 10, borderRadius: 999, flexShrink: 0,
                background: on ? c : 'transparent',
                border: `1px solid ${c}`,
              }} />
              {t.name}
            </button>
          )
        })}
        {hidden.size > 0 && (
          <button
            onClick={() => setHidden(new Set())}
            style={{
              padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--muted)', fontSize: 12, lineHeight: 1.4,
            }}
          >
            Show all
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: excludeInternal ? 8 : 24, fontSize: 13 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={excludeInternal} onChange={e => setExcludeInternal(e.target.checked)} />
          Exclude internal users
        </label>
        <input
          type="text"
          value={domainDraft}
          onChange={e => setDomainDraft(e.target.value)}
          placeholder="internal domains, comma-separated (e.g. bipartisanpolicy.org)"
          style={{ flex: '1 1 320px', minWidth: 220, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}
        />
        <button
          onClick={savingDomains ? undefined : saveDomains}
          disabled={savingDomains}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', cursor: savingDomains ? 'not-allowed' : 'pointer', fontSize: 13 }}
        >
          {savingDomains ? 'Saving…' : 'Save domains'}
        </button>
      </div>
      {excludeInternal && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 24 }}>
          Membership and member-engagement charts exclude activity from {excludeDomains.length > 0 ? excludeDomains.join(', ') : '(no domains set)'}. Applies to data collected after the domains were saved; earlier points show full totals. Other metric groups are unaffected.
        </div>
      )}

      {groups.map(group => {
        const metrics = METRIC_TITLES.filter(m => m.group === group)
        return (
          <section key={group} style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 14, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
              {group}
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
              {metrics.map(m => {
                const perTenant = tenantsForChart.map(t => {
                  const base = series.metrics[m.key]?.[t.id] ?? series.dates.map(() => null)
                  // When excluding internal users, swap in the `__excl` variant for
                  // excludable metrics — falling back to the full value per data point
                  // where no variant was collected (historical rows / no domains set).
                  const excl = excludeInternal && EXCLUDABLE.has(m.key)
                    ? series.metrics[`${m.key}__excl`]?.[t.id]
                    : undefined
                  const values = excl ? base.map((v, i) => (excl[i] != null ? excl[i] : v)) : base
                  return { id: t.id, name: t.name, color: colorById[t.id], values }
                })
                const aggregate = sumDown(perTenant.map(p => p.values))
                return (
                  <EngagementChart
                    key={m.key}
                    title={m.title}
                    current={lastValue(aggregate)}
                    series={{ dates: series.dates, perTenant, aggregate }}
                  />
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
