import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { DataTable, Column } from './DataTable'

// How well one instance's claim links resolve (#573): its stored claim sources
// counted by how each quote matched the bill text, and two signals about
// analyses that stored none. Counts only. The instance answers over its service
// binding, so this can fail for an instance that is unbound or older than the
// feature, and the page around it must still render.

type Counts = {
  analyses: { withClaimSources: number; emptyList: number; noList: number }
  items: { exact: number; normalized: number; fuzzy: number; anchored: number; ungrounded: number; unverified: number; total: number }
  cutOffRetries: number
}

type State = { kind: 'loading' } | { kind: 'ok'; counts: Counts } | { kind: 'unavailable'; reason: string }

const STATUSES = [
  { key: 'exact', label: 'Exact', meaning: 'Found character for character.' },
  { key: 'normalized', label: 'Normalized', meaning: 'Found after folding spacing, curly quotes, and dashes.' },
  { key: 'fuzzy', label: 'Fuzzy', meaning: 'Found by a close match, such as through line numbers or a running header.' },
  { key: 'anchored', label: 'Anchored', meaning: 'Only the start or the end of a long quote matched.' },
  { key: 'ungrounded', label: 'Ungrounded', meaning: 'Not found in the bill text. Shown as plain text, with no link.' },
  { key: 'unverified', label: 'Unverified', meaning: 'A PDF quote the instance cannot check. The link goes by page.' },
] as const

type Row = { label: string; meaning: string; count: number; share: string }

const isCounts = (d: unknown): d is Counts => {
  const c = d as Counts | null
  return !!c && typeof c === 'object'
    && !!c.items && typeof c.items.total === 'number'
    && !!c.analyses && typeof c.analyses.emptyList === 'number'
    && typeof c.cutOffRetries === 'number'
}

const columns: Column<Row>[] = [
  { key: 'status', header: 'Status', cell: r => <strong>{r.label}</strong>, width: 120 },
  { key: 'count', header: 'Claim sources', cell: r => r.count, width: 120 },
  { key: 'share', header: 'Share', cell: r => r.share, width: 80 },
  { key: 'meaning', header: 'What it means', cell: r => <span style={{ color: 'var(--muted)' }}>{r.meaning}</span> },
]

export function ClaimLinkCounts({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let live = true
    setState({ kind: 'loading' })
    api<unknown>(`/admin/dash/tenants/${encodeURIComponent(tenantId)}/claim-sources`)
      .then(d => {
        if (!live) return
        setState(isCounts(d) ? { kind: 'ok', counts: d } : { kind: 'unavailable', reason: 'the instance sent an answer this page does not understand' })
      })
      .catch(err => {
        if (live) setState({ kind: 'unavailable', reason: err instanceof Error ? err.message : 'the request failed' })
      })
    return () => { live = false }
  }, [tenantId])

  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16 }}>Claim links</h2>
      {state.kind === 'loading' && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {state.kind === 'unavailable' && (
        <div style={{ fontSize: 13, color: 'var(--warning)' }}>
          Claim link counts are unavailable: {state.reason}.
        </div>
      )}
      {state.kind === 'ok' && <Loaded counts={state.counts} />}
    </section>
  )
}

function Loaded({ counts }: { counts: Counts }) {
  const { items, analyses } = counts
  const rows: Row[] = STATUSES.map(s => ({
    label: s.label,
    meaning: s.meaning,
    count: items[s.key],
    // Nothing to divide by on an instance with no claim sources yet.
    share: items.total > 0 ? `${((items[s.key] / items.total) * 100).toFixed(1)}%` : '—',
  }))
  rows.push({ label: 'Total', meaning: 'Every claim source stored on the instance.', count: items.total, share: '' })

  const signals: { label: string; value: number }[] = [
    { label: 'With claim sources', value: analyses.withClaimSources },
    { label: 'Asked, none stored', value: analyses.emptyList },
    { label: 'No list stored', value: analyses.noList },
    { label: 'Cut off, retried without claim sources', value: counts.cutOffRetries },
  ]

  return (
    <>
      {items.total === 0 && (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>No claim sources stored yet.</div>
      )}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 12 }}>
        <DataTable rows={rows} columns={columns} rowKey={r => r.label} />
      </div>
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 24px', margin: '0 0 8px', fontSize: 13 }}>
        {signals.map(s => (
          <div key={s.label} style={{ display: 'flex', gap: 8 }}>
            <dt style={{ color: 'var(--muted)' }}>{s.label}</dt>
            <dd style={{ margin: 0, fontWeight: 600 }}>{s.value}</dd>
          </div>
        ))}
      </dl>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, maxWidth: 720 }}>
        Counted from each bill's stored claim sources. An analysis that asked for claim sources and got nothing usable back
        is counted under Asked, none stored. An AI-processed bill with no list at all is counted under No list stored: it was
        analyzed before claim links, with the setting off, on its title and abstract alone, or retried without claim sources
        after a cut-off response. The cut-off count starts from when the instance began counting them.
      </p>
    </>
  )
}
