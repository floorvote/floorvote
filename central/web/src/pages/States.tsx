import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { DataTable, Column } from '../components/DataTable'

type CallCoverage = 'full' | 'partial' | 'none'

// The row the states endpoint sends (central/src/lib/stateRows.ts).
type StateRow = {
  state: string
  tenantCount: number
  provider: {
    id: string
    name: string
    since: string | null
    sinceKind: 'default' | 'claim' | 'cutover'
    undoAvailable: boolean
    otherProviders: string[]
  }
  configured: { keyStatus: 'set' | 'missing' | 'not_required'; queue: 'default' | 'own' | 'shared'; warning: string | null }
  schedule: {
    fullHours: number[]
    rawHours: number[] | null
    override: boolean
    lastRead: string | null
    nextRead: string | null
    stale: boolean
    lastPass: { billsChecked: number; billsChanged: number; billsQueued: number } | null
  }
  waitingFirstIngest: number
  calls: { provider: string; count: number; coverage: CallCoverage }
  capabilities: { bodyEvents: boolean; deadlines: boolean; calendarEvents: { bill: number; body: number } }
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

/** "3 hours ago" for a past time, "in 2 hours" for a future one. */
function relative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  const minutes = Math.round(Math.abs(ms) / 60_000)
  const span = minutes < 1 ? 'less than a minute'
    : minutes < 60 ? plural(minutes, 'minute')
    : minutes < 60 * 24 ? plural(Math.round(minutes / 60), 'hour')
    : plural(Math.round(minutes / (60 * 24)), 'day')
  return ms < 0 ? `${span} ago` : `in ${span}`
}

const muted = { color: 'var(--muted)' } as const
const line = { marginBottom: 2 } as const

function callsText({ count, coverage }: StateRow['calls']): string {
  if (coverage === 'none') return 'Not recorded'
  const text = `${plural(count, 'call')} this month`
  return coverage === 'partial' ? `${text} (partial)` : text
}

const QUEUE_TEXT = { default: "LegiScan's queue", own: 'Own ingest queue', shared: "Shares LegiScan's queue" } as const
const KEY_TEXT = { set: 'Key set', missing: 'Key missing', not_required: 'No key needed' } as const

const columns: Column<StateRow>[] = [
  {
    key: 'state',
    header: 'State',
    width: 90,
    cell: r => (
      <>
        <strong>{r.state}</strong>
        <div style={{ ...muted, fontSize: 12 }}>{r.tenantCount === 0 ? 'No tenants' : plural(r.tenantCount, 'tenant')}</div>
      </>
    ),
  },
  {
    key: 'provider',
    header: 'Provider',
    cell: r => (
      <>
        <div style={line}><span>{r.provider.name}</span></div>
        {r.provider.sinceKind !== 'default' && r.provider.since && (
          <div style={{ ...line, ...muted }}>
            {r.provider.sinceKind === 'cutover' ? 'Cut over' : 'Claimed'} {new Date(r.provider.since).toLocaleDateString()}
          </div>
        )}
        {r.provider.undoAvailable && <div style={{ ...line, color: 'var(--warning)' }}>Undo available</div>}
        {r.provider.otherProviders.length > 0 && (
          <div style={{ ...line, ...muted }}>Also holds sessions from {r.provider.otherProviders.join(', ')}</div>
        )}
      </>
    ),
  },
  {
    key: 'configured',
    header: 'Configured',
    cell: r => (
      <>
        {r.configured.warning && <div role="alert" style={{ ...line, color: 'var(--danger)' }}>{r.configured.warning}</div>}
        <div style={line}>{KEY_TEXT[r.configured.keyStatus]}</div>
        <div style={{ ...line, ...muted }}>{QUEUE_TEXT[r.configured.queue]}</div>
      </>
    ),
  },
  {
    key: 'schedule',
    header: 'Schedule',
    cell: r => {
      const s = r.schedule
      return (
        <>
          <div style={line}>
            Full {s.fullHours.join(', ')} ET
            {s.override && <span style={{ color: 'var(--warning)' }}> · Override</span>}
          </div>
          {s.rawHours && <div style={{ ...line, ...muted }}>Raw {s.rawHours.join(', ')} ET</div>}
          <div style={line}>{s.lastRead ? `Last read ${relative(s.lastRead)}` : 'Never read'}</div>
          {s.stale && <div style={{ ...line, color: 'var(--warning)' }}>No recent read</div>}
          <div style={line}>{s.nextRead ? `Next read ${relative(s.nextRead)}` : 'Nothing scheduled'}</div>
          <div style={{ ...line, ...muted }}>
            {s.lastPass
              ? `${s.lastPass.billsChecked} checked · ${s.lastPass.billsChanged} changed · ${s.lastPass.billsQueued} queued`
              : 'No pass logged'}
          </div>
        </>
      )
    },
  },
  {
    key: 'waiting',
    header: 'After a cutover',
    cell: r => r.waitingFirstIngest > 0
      ? `${plural(r.waitingFirstIngest, 'bill')} waiting for first ingest`
      : <span style={muted}>—</span>,
  },
  {
    key: 'calls',
    header: 'Calls',
    cell: r => callsText(r.calls),
  },
  {
    key: 'capabilities',
    header: 'Capabilities',
    cell: r => {
      const c = r.capabilities
      const held = c.calendarEvents.bill + c.calendarEvents.body
      return (
        <>
          {c.bodyEvents && <div style={line}>Body events</div>}
          {c.deadlines && <div style={line}>Deadlines</div>}
          <div style={{ ...line, ...muted }}>{plural(held, 'calendar event')}</div>
        </>
      )
    },
  },
]

export default function States() {
  const [rows, setRows] = useState<StateRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    api<{ states: StateRow[] }>('/admin/dash/states').then(d => setRows(d.states), () => setFailed(true))
  }, [])

  return (
    <div>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>States</h1>
      <p style={{ ...muted, fontSize: 13, margin: '0 0 16px' }}>
        Which provider reads each state, whether it can run here, and how its reads are going. Calls are the provider's
        total for the month, since the call log doesn't record a state.
      </p>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {failed ? <div style={{ padding: 16, color: 'var(--danger)' }}>Couldn't load states.</div>
          : rows === null ? <div style={{ padding: 16, ...muted }}>Loading…</div>
          : <DataTable rows={rows} columns={columns} rowKey={r => r.state} empty="No states." />}
      </div>
    </div>
  )
}
