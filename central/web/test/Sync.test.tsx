import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Sync from '../src/pages/Sync'

function mockFetch(stale: boolean) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url)
    if (u.includes('/sync/states')) return new Response(JSON.stringify({ data: { states: [{ state: 'RI', activeSessions: 1, lastSyncedAt: '2026-05-28T10:00:00Z', lastBillChangeAt: null, stale }] }, meta: {} }))
    if (u.includes('/sync/sessions')) return new Response(JSON.stringify({ data: { active: [], sineDie: [] }, meta: {} }))
    if (u.includes('/sync/keyword-union')) return new Response(JSON.stringify({ data: { states: [] }, meta: {} }))
    if (u.includes('/sync/ticks')) return new Response(JSON.stringify({ data: { syncs: [] }, meta: {} }))
    return new Response('{}')
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockFetch(false)
})

describe('Sync page', () => {
  it('renders sections', async () => {
    render(<MemoryRouter><Sync /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('RI')).toBeInTheDocument())
  })

  it('does not show stale legend when no rows are stale', async () => {
    render(<MemoryRouter><Sync /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('RI')).toBeInTheDocument())
    expect(screen.queryByText(/48\+ hours/i)).not.toBeInTheDocument()
  })

  it('shows stale legend and applies row-stale class when a state is stale', async () => {
    mockFetch(true)
    render(<MemoryRouter><Sync /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('RI')).toBeInTheDocument())
    expect(screen.getByText(/48\+ hours/i)).toBeInTheDocument()
    // The row for RI should have row-stale class
    const riCell = screen.getByText('RI')
    const row = riCell.closest('tr')
    expect(row).toHaveClass('row-stale')
  })
})
