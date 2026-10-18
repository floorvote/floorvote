import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'

// A plain function behind the mock: vitest reports a rejection that a vi.fn returned as unhandled.
const calls: unknown[][] = []
let respond: () => Promise<unknown> = async () => ({ states: [] })
vi.mock('../lib/api', () => ({ api: (...a: unknown[]) => { calls.push(a); return respond() } }))

import States from './States'

type Row = Record<string, any>
const row = (over: Row = {}): Row => ({
  state: 'RI',
  tenantCount: 2,
  provider: { id: 'legiscan', name: 'LegiScan', since: null, sinceKind: 'default', undoAvailable: false, otherProviders: [] },
  configured: { keyStatus: 'not_required', queue: 'default', warning: null },
  schedule: {
    fullHours: [5, 13, 23], rawHours: [7, 9], override: false,
    lastRead: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    nextRead: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    stale: false, lastPass: { billsChecked: 40, billsChanged: 7, billsQueued: 3 },
  },
  waitingFirstIngest: 0,
  calls: { provider: 'legiscan', count: 1200, coverage: 'full' },
  capabilities: { bodyEvents: false, deadlines: true, calendarEvents: { bill: 4, body: 0 } },
  ...over,
})
const merge = (base: Row, over: Row) => ({ ...base, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, { ...base[k], ...v }])) })

async function show(rows: Row[]) {
  respond = async () => ({ states: rows })
  render(<States />)
  await screen.findByRole('heading', { name: 'States' })
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
}
const rowEl = (state: string) => screen.getByRole('row', { name: new RegExp(`^${state}\\b`) })

beforeEach(() => { calls.length = 0 })

describe('States page', () => {
  it('reads the states endpoint', async () => {
    await show([row()])
    expect(calls).toEqual([['/admin/dash/states']])
  })

  it('says so when there are no states', async () => {
    await show([])
    expect(screen.getByText(/No states/)).toBeInTheDocument()
  })

  it('says so when the states cannot be loaded', async () => {
    respond = () => Promise.reject(new Error('boom'))
    render(<States />)
    expect(await screen.findByText(/Couldn.t load states/)).toBeInTheDocument()
  })

  it('shows a LegiScan-only state with no warning or undo note', async () => {
    await show([row()])
    const r = within(rowEl('RI'))
    expect(r.getByText('LegiScan')).toBeInTheDocument()
    expect(r.queryByText(/Undo available/)).toBeNull()
    expect(r.queryByRole('alert')).toBeNull()
    expect(r.getByText(/No key needed/)).toBeInTheDocument()
  })

  it('shows the claim or cutover date and undo available only while it can be undone', async () => {
    const since = '2026-09-20T08:00:00.000Z'
    const provider = { id: 'lims', name: 'DC Council', since, sinceKind: 'cutover' }
    await show([
      row({ state: 'DC', provider: { ...row().provider, ...provider, undoAvailable: true } }),
      row({ state: 'MD', provider: { ...row().provider, ...provider, undoAvailable: false } }),
    ])
    const date = new Date(since).toLocaleDateString()
    expect(within(rowEl('DC')).getByText(new RegExp(`Cut over ${date}`))).toBeInTheDocument()
    expect(within(rowEl('DC')).getByText(/Undo available/)).toBeInTheDocument()
    expect(within(rowEl('MD')).queryByText(/Undo available/)).toBeNull()
  })

  it('says claimed for a claim, and lists the other provider holding sessions', async () => {
    await show([row({ provider: { ...row().provider, id: 'lis', name: 'Virginia General Assembly', since: '2026-09-01T00:00:00.000Z', sinceKind: 'claim', otherProviders: ['legiscan'] } })])
    const r = within(rowEl('RI'))
    expect(r.getByText(new RegExp(`Claimed ${new Date('2026-09-01T00:00:00.000Z').toLocaleDateString()}`))).toBeInTheDocument()
    expect(r.getByText(/Also holds sessions from legiscan/)).toBeInTheDocument()
  })

  it('shows the unconfigured warning as an alert', async () => {
    await show([merge(row({ provider: { ...row().provider, id: 'lims', name: 'DC Council' } }), {
      configured: { keyStatus: 'missing', warning: "DC Council owns this state but isn't configured, so the state isn't syncing" },
    })])
    const r = within(rowEl('RI'))
    expect(r.getByRole('alert')).toHaveTextContent(/isn't configured/)
    expect(r.getByText(/Key missing/)).toBeInTheDocument()
  })

  it('shows whether the key is set and which queue the provider uses', async () => {
    await show([
      merge(row({ state: 'AA' }), { configured: { keyStatus: 'set', queue: 'own' } }),
      merge(row({ state: 'BB' }), { configured: { keyStatus: 'set', queue: 'shared' } }),
      merge(row({ state: 'CC' }), { configured: { queue: 'default' } }),
    ])
    expect(within(rowEl('AA')).getByText(/Key set/)).toBeInTheDocument()
    expect(within(rowEl('AA')).getByText(/Own ingest queue/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/Shares LegiScan.s queue/)).toBeInTheDocument()
    expect(within(rowEl('CC')).getByText(/LegiScan.s queue/)).toBeInTheDocument()
  })

  it('shows the read hours, an override marker, and the last pass counts', async () => {
    await show([
      merge(row({ state: 'AA' }), { schedule: { override: true } }),
      row({ state: 'BB' }),
    ])
    const a = within(rowEl('AA'))
    expect(a.getByText(/Full 5, 13, 23 ET/)).toBeInTheDocument()
    expect(a.getByText(/Raw 7, 9 ET/)).toBeInTheDocument()
    expect(a.getByText(/Override/)).toBeInTheDocument()
    expect(a.getByText(/40 checked · 7 changed · 3 queued/)).toBeInTheDocument()
    expect(within(rowEl('BB')).queryByText(/Override/)).toBeNull()
  })

  it('omits raw hours for a snapshot provider', async () => {
    await show([merge(row(), { schedule: { rawHours: null } })])
    expect(within(rowEl('RI')).queryByText(/Raw/)).toBeNull()
  })

  it('shows last and next read, and flags a state with no recent read', async () => {
    await show([
      row({ state: 'AA' }),
      merge(row({ state: 'BB' }), { schedule: { lastRead: null, nextRead: null, stale: true, lastPass: null } }),
    ])
    expect(within(rowEl('AA')).getByText(/Last read 3 hours ago/)).toBeInTheDocument()
    expect(within(rowEl('AA')).getByText(/Next read in 2 hours/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/Never read/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/No recent read/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/Nothing scheduled/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/No pass logged/)).toBeInTheDocument()
  })

  it('shows how many moved bills still wait for their first ingest', async () => {
    await show([row({ state: 'AA', waitingFirstIngest: 17 }), row({ state: 'BB' })])
    expect(within(rowEl('AA')).getByText(/17 bills waiting for first ingest/)).toBeInTheDocument()
    expect(within(rowEl('BB')).queryByText(/waiting for first ingest/)).toBeNull()
  })

  it('says one bill, not one bills', async () => {
    await show([row({ waitingFirstIngest: 1 })])
    expect(within(rowEl('RI')).getByText(/1 bill waiting for first ingest/)).toBeInTheDocument()
  })

  it('shows logged calls, marks partial ones, and says not recorded rather than zero', async () => {
    await show([
      row({ state: 'AA' }),
      row({ state: 'BB', calls: { provider: 'lis', count: 9, coverage: 'partial' } }),
      row({ state: 'CC', calls: { provider: 'mga', count: 0, coverage: 'none' } }),
      row({ state: 'DD', calls: { provider: 'lims', count: 0, coverage: 'full' } }),
    ])
    expect(within(rowEl('AA')).getByText(/1,200 calls this month/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/9 calls this month \(partial\)/)).toBeInTheDocument()
    expect(within(rowEl('CC')).getByText(/Not recorded/)).toBeInTheDocument()
    expect(within(rowEl('CC')).queryByText(/0 calls/)).toBeNull()
    expect(within(rowEl('DD')).getByText(/0 calls this month/)).toBeInTheDocument()
  })

  it('shows what the state data supports and the calendar events held', async () => {
    await show([
      merge(row({ state: 'AA' }), { capabilities: { bodyEvents: true, deadlines: false, calendarEvents: { bill: 2, body: 3 } } }),
      row({ state: 'BB' }),
    ])
    expect(within(rowEl('AA')).getByText(/Body events/)).toBeInTheDocument()
    expect(within(rowEl('AA')).queryByText(/Deadlines/)).toBeNull()
    expect(within(rowEl('AA')).getByText(/5 calendar events/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/Deadlines/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/4 calendar events/)).toBeInTheDocument()
  })

  it('shows the state\'s tenant count, including none', async () => {
    await show([row({ state: 'AA', tenantCount: 0 }), row({ state: 'BB', tenantCount: 1 })])
    expect(within(rowEl('AA')).getByText(/No tenants/)).toBeInTheDocument()
    expect(within(rowEl('BB')).getByText(/1 tenant\b/)).toBeInTheDocument()
  })
})
