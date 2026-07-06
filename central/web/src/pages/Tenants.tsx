import { Fragment, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { StackedBar } from '../components/StackedBar'

type StateCounts = { state: string; keyword: number; manual: number; null: number; total: number }
type T = {
  id: string
  name: string
  states: string[]
  billCounts: { keyword: number; manual: number; null: number; total: number }
  stateBreakdown: StateCounts[]
  keywordCount: number
  lastBillIngestedAt: string | null
  lastActivityAt: string | null
}

function fmt(d: string | null): string { return d ? new Date(d).toLocaleDateString() : '—' }

export default function Tenants() {
  const [rows, setRows] = useState<T[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  useEffect(() => { api<{ tenants: T[] }>('/admin/dash/tenants').then(r => setRows(r.tenants)) }, [])

  function toggle(id: string) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <div>
      <h1 style={{ marginTop: 0, fontSize: 24 }}>Tenants</h1>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6 }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>No tenants.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle} />
                <th style={thStyle}>ID</th>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>States</th>
                <th style={thStyle}>Tracked</th>
                <th style={thStyle}>Match split</th>
                <th style={thStyle}># keywords</th>
                <th style={thStyle}>Last bill</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isMultiState = r.states.length > 1 || r.states.includes('*')
                const isOpen = expanded[r.id]
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td style={{ ...tdStyle, width: 24 }}>
                        {isMultiState && (
                          <button
                            onClick={() => toggle(r.id)}
                            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, padding: '0 4px' }}
                            aria-label={isOpen ? 'Collapse' : 'Expand'}
                          >
                            {isOpen ? '▾' : '▸'}
                          </button>
                        )}
                      </td>
                      <td style={tdStyle}><Link to={`/tenants/${r.id}`}>{r.id}</Link></td>
                      <td style={tdStyle}>{r.name}</td>
                      <td style={tdStyle}>{r.states.join(', ')}</td>
                      <td style={tdStyle}>{(r.billCounts.keyword + r.billCounts.manual).toLocaleString()}</td>
                      <td style={tdStyle}>
                        <div style={{ minWidth: 140 }}>
                          <StackedBar segments={[
                            { label: 'keyword', value: r.billCounts.keyword, color: 'var(--accent)' },
                            { label: 'manual', value: r.billCounts.manual, color: '#7c3aed' },
                            { label: 'stub', value: r.billCounts.null, color: '#cbd5e1' },
                          ]} />
                        </div>
                      </td>
                      <td style={tdStyle}>{r.keywordCount.toLocaleString()}</td>
                      <td style={tdStyle}>{fmt(r.lastBillIngestedAt)}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={7} style={{ background: '#f8fafc', padding: '8px 10px 16px', borderBottom: '1px solid var(--border)' }}>
                          {r.stateBreakdown.length === 0 ? (
                            <div style={{ color: 'var(--muted)', fontSize: 12 }}>No bills ingested yet for this tenant.</div>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr>
                                  <th style={subThStyle}>State</th>
                                  <th style={subThStyle}>Tracked</th>
                                  <th style={subThStyle}>Keyword</th>
                                  <th style={subThStyle}>Manual</th>
                                  <th style={subThStyle}>Stub</th>
                                  <th style={subThStyle}>Match split</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.stateBreakdown.map(s => (
                                  <tr key={s.state}>
                                    <td style={subTdStyle}><strong>{s.state}</strong></td>
                                    <td style={subTdStyle}>{(s.keyword + s.manual).toLocaleString()}</td>
                                    <td style={subTdStyle}>{s.keyword.toLocaleString()}</td>
                                    <td style={subTdStyle}>{s.manual.toLocaleString()}</td>
                                    <td style={subTdStyle}>{s.null.toLocaleString()}</td>
                                    <td style={subTdStyle}>
                                      <div style={{ minWidth: 140 }}>
                                        <StackedBar segments={[
                                          { label: 'keyword', value: s.keyword, color: 'var(--accent)' },
                                          { label: 'manual', value: s.manual, color: '#7c3aed' },
                                          { label: 'stub', value: s.null, color: '#cbd5e1' },
                                        ]} />
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
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
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--muted)', fontWeight: 600 }
const tdStyle: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--border)' }
const subThStyle: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', color: 'var(--muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }
const subTdStyle: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid #e5e7eb' }
