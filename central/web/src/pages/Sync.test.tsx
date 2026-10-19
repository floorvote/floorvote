import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'

// A plain function behind the mock: vitest reports a rejection that a vi.fn returned as unhandled.
let ticks: unknown[] = []
vi.mock('../lib/api', () => ({
  api: async (path: string) => {
    if (path === '/admin/dash/sync/ticks') return { syncs: ticks }
    if (path === '/admin/dash/sync/sessions') return { active: [], sineDie: [] }
    if (path === '/admin/dash/sync/keyword-union') return { states: [] }
    return { states: [] }
  },
}))

import Sync from './Sync'

const tick = (over: Record<string, unknown> = {}) => ({
  id: 1, sessionId: 1, sessionName: 'RI 2026', state: 'RI', syncedAt: '2026-10-14T05:00:00.000Z',
  billsChecked: 40, billsChanged: 7, billsQueued: 3, status: 'ok', error: null, ...over,
})

async function show(rows: unknown[]) {
  ticks = rows
  const view = render(<Sync />)
  await screen.findByRole('heading', { name: 'Sync' })
  await waitFor(() => expect(screen.queryByText('No syncs.')).toBeNull())
  return view
}
const rowFor = (name: string) => screen.getByRole('row', { name: new RegExp(name) })

beforeEach(() => { ticks = [] })

describe('Sync page: recent syncs', () => {
  it('shows a pass that finished with its counts', async () => {
    await show([tick()])
    const r = within(rowFor('RI 2026'))
    expect(r.getByText('40')).toBeInTheDocument()
    expect(r.getByText('7')).toBeInTheDocument()
    expect(r.queryByText(/Failed/)).toBeNull()
  })

  it('shows a failed pass as failed with its error, not as a sync that found nothing', async () => {
    await show([tick({ id: 2, sessionName: 'DC 2026', state: 'DC', billsChecked: 0, billsChanged: 0, billsQueued: 0, status: 'failed', error: 'LIMS HTTP 503 for /BulkData' })])
    const r = within(rowFor('DC 2026'))
    expect(r.getByText(/Failed/)).toBeInTheDocument()
    expect(r.getByText(/LIMS HTTP 503 for \/BulkData/)).toBeInTheDocument()
    expect(r.queryByText('0')).toBeNull()
  })

  it('shows a failed pass with no error as failed', async () => {
    await show([tick({ id: 2, sessionName: 'DC 2026', billsChecked: 0, billsChanged: 0, billsQueued: 0, status: 'failed', error: null })])
    expect(within(rowFor('DC 2026')).getByText(/Failed/)).toBeInTheDocument()
  })

  it('renders an error as plain text, never as markup', async () => {
    const { container } = await show([tick({ id: 2, sessionName: 'DC 2026', status: 'failed', error: '<img src=x onerror=alert(1)><b>bold</b>' })])
    expect(within(rowFor('DC 2026')).getByText(/<img src=x onerror=alert\(1\)><b>bold<\/b>/)).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('shows a pass that finished with nothing as zeros, not as failed', async () => {
    await show([tick({ billsChecked: 0, billsChanged: 0, billsQueued: 0 })])
    const r = within(rowFor('RI 2026'))
    expect(r.getAllByText('0')).toHaveLength(3)
    expect(r.queryByText(/Failed/)).toBeNull()
  })

  it('shows a failed pass beside a pass that finished, each as what it is', async () => {
    await show([
      tick({ id: 2, sessionName: 'DC 2026', status: 'failed', error: 'boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 }),
      tick({ id: 1 }),
    ])
    expect(within(rowFor('DC 2026')).getByText(/Failed/)).toBeInTheDocument()
    expect(within(rowFor('RI 2026')).getByText('40')).toBeInTheDocument()
  })

  it('does not offer to expand a failed pass\'s changes', async () => {
    await show([tick({ id: 2, sessionName: 'DC 2026', status: 'failed', error: 'boom', billsChecked: 0, billsChanged: 0, billsQueued: 0 })])
    expect(within(rowFor('DC 2026')).getByRole('button')).toBeDisabled()
  })
})
