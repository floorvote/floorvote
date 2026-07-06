import { Fragment, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { DataTable, Column } from '../components/DataTable'

type StateRow = { state: string; activeSessions: number; lastSyncedAt: string | null; lastBillChangeAt: string | null; stale: boolean }
type SessionRow = {
  sessionId: number
  state: string
  sessionName: string
  yearStart: number
  yearEnd: number
  billCount: number
  lastSyncedAt: string | null
  fullSyncHours: number[]
  fullSyncIsDefault: boolean
  rawSyncHours: number[]
  rawSyncIsDefault: boolean
  syncEnabled: boolean
  sineDie: boolean
}
type KwUnion = { state: string; contributingTenants: string[]; keywordCount: number; sampleKeywords: string[] }
type SyncRow = { id: number; sessionId: number; sessionName: string; state: string; syncedAt: string; billsChecked: number; billsChanged: number; billsQueued: number }
type ChangeEntry = { billId: number; state: string; billNumber: string; changeType: string; oldValue: string | null; newValue: string | null; detail: string | null; detectedAt: string }

function fmt(d: string | null): string { return d ? new Date(d).toLocaleString() : '—' }
function fmtHours(hours: number[], isDefault: boolean): string {
  const str = hours.length ? hours.join(', ') : '—'
  return isDefault ? `${str} (default)` : str
}

type BillGroup = { billId: number; state: string; billNumber: string; entries: ChangeEntry[] }
function groupByBill(entries: ChangeEntry[]): BillGroup[] {
  const map = new Map<number, BillGroup>()
  for (const c of entries) {
    if (!map.has(c.billId)) map.set(c.billId, { billId: c.billId, state: c.state, billNumber: c.billNumber, entries: [] })
    map.get(c.billId)!.entries.push(c)
  }
  return Array.from(map.values()).sort((a, b) => b.entries.length - a.entries.length)
}

function countTypes(entries: ChangeEntry[]): { type: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(e.changeType, (counts.get(e.changeType) ?? 0) + 1)
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }))
}

export default function Sync() {
  const [states, setStates] = useState<StateRow[]>([])
  const [activeSessions, setActiveSessions] = useState<SessionRow[]>([])
  const [sineDieSessions, setSineDieSessions] = useState<SessionRow[]>([])
  const [kw, setKw] = useState<KwUnion[]>([])
  const [syncs, setSyncs] = useState<SyncRow[]>([])
  const [expanded, setExpanded] = useState<Record<number, ChangeEntry[] | 'loading' | 'error'>>({})
  const [openBills, setOpenBills] = useState<Record<string, boolean>>({})
  const [sineDieOpen, setSineDieOpen] = useState(false)

  useEffect(() => {
    api<{ states: StateRow[] }>('/admin/dash/sync/states').then(r => setStates(r.states))
    api<{ active: SessionRow[]; sineDie: SessionRow[] }>('/admin/dash/sync/sessions').then(r => {
      setActiveSessions(r.active)
      setSineDieSessions(r.sineDie)
    })
    api<{ states: KwUnion[] }>('/admin/dash/sync/keyword-union').then(r => setKw(r.states))
    api<{ syncs: SyncRow[] }>('/admin/dash/sync/ticks').then(r => setSyncs(r.syncs))
  }, [])

  async function toggleExpand(id: number) {
    if (expanded[id] !== undefined) {
      const next = { ...expanded }
      delete next[id]
      setExpanded(next)
      return
    }
    setExpanded(prev => ({ ...prev, [id]: 'loading' }))
    try {
      const r = await api<{ changes: ChangeEntry[] }>(`/admin/dash/sync/ticks/${id}/changes`)
      setExpanded(prev => ({ ...prev, [id]: r.changes }))
    } catch {
      setExpanded(prev => ({ ...prev, [id]: 'error' }))
    }
  }

  const stateCols: Column<StateRow>[] = [
    { key: 's', header: 'State', cell: r => <strong style={{ color: r.stale ? 'var(--danger)' : 'inherit' }}>{r.state}</strong> },
    { key: 'as', header: '# sessions', cell: r => r.activeSessions.toLocaleString() },
    { key: 'ls', header: 'Last sync', cell: r => fmt(r.lastSyncedAt) },
    { key: 'lb', header: 'Last bill change', cell: r => fmt(r.lastBillChangeAt) },
  ]
  const sessionCols: Column<SessionRow>[] = [
    { key: 's', header: 'State', cell: r => r.state },
    { key: 'n', header: 'Session', cell: r => r.sessionName },
    { key: 'y', header: 'Years', cell: r => `${r.yearStart}–${r.yearEnd}` },
    { key: 'b', header: '# bills', cell: r => r.billCount.toLocaleString() },
    { key: 'ls', header: 'Last synced', cell: r => fmt(r.lastSyncedAt) },
    { key: 'f', header: 'Full sync (ET)', cell: r => fmtHours(r.fullSyncHours, r.fullSyncIsDefault) },
    { key: 'r', header: 'Raw sync (ET)', cell: r => fmtHours(r.rawSyncHours, r.rawSyncIsDefault) },
  ]
  const sineDieCols: Column<SessionRow>[] = [
    { key: 's', header: 'State', cell: r => r.state },
    { key: 'n', header: 'Session', cell: r => r.sessionName },
    { key: 'y', header: 'Years', cell: r => `${r.yearStart}–${r.yearEnd}` },
    { key: 'b', header: '# bills', cell: r => r.billCount.toLocaleString() },
    { key: 'ls', header: 'Last synced', cell: r => fmt(r.lastSyncedAt) },
  ]
  const kwCols: Column<KwUnion>[] = [
    { key: 's', header: 'State', cell: r => r.state },
    { key: 'ct', header: 'Contributing tenants', cell: r => r.contributingTenants.join(', ') },
    { key: 'kc', header: '# keywords', cell: r => r.keywordCount.toLocaleString() },
    { key: 'sk', header: 'Sample', cell: r => r.sampleKeywords.join(', ') },
  ]

  function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>{title}</h2>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>{children}</div>
      </div>
    )
  }

  return (
    <div>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>Sync</h1>
      <Section title="Per-state status">
        {states.some(s => s.stale) && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ color: 'var(--danger)' }}>●</span> No sync in 48+ hours
          </div>
        )}
        <DataTable rows={states} columns={stateCols} rowKey={r => r.state}
          rowClassName={r => r.stale ? 'row-stale' : undefined} />
      </Section>
      <Section title={`Active sessions (${activeSessions.length})`}>
        <DataTable rows={activeSessions} columns={sessionCols} rowKey={r => r.sessionId} empty="No active sessions." />
      </Section>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>
          <button
            onClick={() => setSineDieOpen(o => !o)}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              font: 'inherit',
              cursor: 'pointer',
              color: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
            aria-expanded={sineDieOpen}
          >
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sineDieOpen ? '▾' : '▸'}</span>
            Sine die sessions ({sineDieSessions.length})
          </button>
        </h2>
        {sineDieOpen && (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <DataTable rows={sineDieSessions} columns={sineDieCols} rowKey={r => r.sessionId} empty="No sine die sessions." />
          </div>
        )}
      </div>
      <Section title="Per-state keyword union">
        <DataTable rows={kw} columns={kwCols} rowKey={r => r.state} />
      </Section>
      <Section title="Recent syncs">
        {syncs.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>No syncs.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle} />
                <th style={thStyle}>When</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Session</th>
                <th style={thStyle} title="Bills examined in the session's masterlist this sync">Bills checked</th>
                <th style={thStyle} title="Bills whose change_hash differed from what was stored (bill-level count)">Changed bills</th>
                <th style={thStyle} title="Subset of changed bills forwarded to the ingestor for full fetch">Queued bills</th>
              </tr>
            </thead>
            <tbody>
              {syncs.map(s => {
                const isOpen = expanded[s.id] !== undefined
                const content = expanded[s.id]
                return (
                  <Fragment key={s.id}>
                    <tr>
                      <td style={tdStyle}>
                        <button
                          onClick={() => toggleExpand(s.id)}
                          disabled={s.billsChanged === 0}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            cursor: s.billsChanged === 0 ? 'default' : 'pointer',
                            color: s.billsChanged === 0 ? 'var(--border)' : 'var(--accent)',
                            fontSize: 12,
                            padding: '0 4px',
                          }}
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                      </td>
                      <td style={tdStyle}>{fmt(s.syncedAt)}</td>
                      <td style={tdStyle}>{s.state}</td>
                      <td style={tdStyle}>{s.sessionName}</td>
                      <td style={tdStyle}>{s.billsChecked.toLocaleString()}</td>
                      <td style={tdStyle}>{s.billsChanged.toLocaleString()}</td>
                      <td style={tdStyle}>{s.billsQueued.toLocaleString()}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={6} style={{ background: '#f8fafc', padding: '8px 10px 16px', borderBottom: '1px solid var(--border)' }}>
                          {content === 'loading' && <div style={{ color: 'var(--muted)' }}>Loading changes…</div>}
                          {content === 'error' && <div style={{ color: 'var(--danger)' }}>Failed to load changes.</div>}
                          {Array.isArray(content) && (
                            content.length === 0 ? (
                              <div style={{ color: 'var(--muted)' }}>No field-level changes recorded for bills queued in this sync's window.</div>
                            ) : (
                              <div>
                                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                                  {content.length.toLocaleString()} field change{content.length === 1 ? '' : 's'} across {groupByBill(content).length} bill{groupByBill(content).length === 1 ? '' : 's'} — click a bill to see its changes
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                  <thead>
                                    <tr>
                                      <th style={subThStyle} />
                                      <th style={subThStyle}>Bill</th>
                                      <th style={subThStyle}># changes</th>
                                      <th style={subThStyle}>Change types</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {groupByBill(content).map(g => {
                                      const billKey = `${s.id}:${g.billId}`
                                      const billOpen = openBills[billKey]
                                      const typeCounts = countTypes(g.entries)
                                      return (
                                        <Fragment key={g.billId}>
                                          <tr>
                                            <td style={subTdStyle}>
                                              <button
                                                onClick={() => setOpenBills(p => ({ ...p, [billKey]: !p[billKey] }))}
                                                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--accent)', fontSize: 11, padding: '0 4px' }}
                                                aria-label={billOpen ? 'Collapse' : 'Expand'}
                                              >
                                                {billOpen ? '▾' : '▸'}
                                              </button>
                                            </td>
                                            <td style={subTdStyle}><strong>{g.state} {g.billNumber}</strong></td>
                                            <td style={subTdStyle}>{g.entries.length}</td>
                                            <td style={subTdStyle}>{typeCounts.map(t => `${t.type}${t.count > 1 ? ` ×${t.count}` : ''}`).join(', ')}</td>
                                          </tr>
                                          {billOpen && (
                                            <tr>
                                              <td />
                                              <td colSpan={3} style={{ background: '#eef2f7', padding: '6px 8px 10px' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                                                  <thead>
                                                    <tr>
                                                      <th style={subThStyle}>Change</th>
                                                      <th style={subThStyle}>From → To</th>
                                                      <th style={subThStyle}>When</th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {g.entries.map(c => (
                                                      <tr key={`${c.detectedAt}-${c.changeType}-${c.newValue ?? ''}-${c.oldValue ?? ''}`}>
                                                        <td style={subTdStyle}>{c.changeType}</td>
                                                        <td style={subTdStyle}>{c.oldValue ?? '∅'} → {c.newValue ?? '∅'}</td>
                                                        <td style={subTdStyle}>{new Date(c.detectedAt).toLocaleString()}</td>
                                                      </tr>
                                                    ))}
                                                  </tbody>
                                                </table>
                                              </td>
                                            </tr>
                                          )}
                                        </Fragment>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  )
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontWeight: 600 }
const tdStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--border)' }
const subThStyle: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', color: 'var(--muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }
const subTdStyle: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid #e5e7eb' }
