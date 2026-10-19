import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from '../src/pages/Settings'

const EVERY_HOUR = Array.from({ length: 24 }, (_, h) => h)
let active: unknown[] | null = null
const mdSession = (over: Record<string, unknown> = {}) => ({
  sessionId: 10, state: 'MD', sessionName: 'MD 2026', yearStart: 2026, yearEnd: 2026, billCount: 3,
  lastSyncedAt: null, fullSyncHours: EVERY_HOUR, fullSyncIsDefault: true, rawSyncHours: [], rawSyncIsDefault: true,
  defaultFullHours: EVERY_HOUR, defaultRawHours: [], snapshot: true, syncEnabled: true, sineDie: false, ...over,
})

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    const u = String(url)
    if (active && u.includes('/sync/sessions') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ data: { active, sineDie: [] }, meta: {} }))
    }
    if (u.includes('/sync/sessions') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ data: {
        active: [{ sessionId: 10, state: 'RI', sessionName: 'RI 2026', yearStart: 2026, yearEnd: 2026, billCount: 3, lastSyncedAt: null, fullSyncHours: [5, 13, 23], fullSyncIsDefault: true, rawSyncHours: [7, 9, 11, 15, 17, 19, 21], rawSyncIsDefault: true, defaultFullHours: [5, 13, 23], defaultRawHours: [7, 9, 11, 15, 17, 19, 21], snapshot: false, syncEnabled: true, sineDie: false }],
        sineDie: [{ sessionId: 11, state: 'RI', sessionName: 'RI 2024', yearStart: 2024, yearEnd: 2024, billCount: 9, lastSyncedAt: null, fullSyncHours: [5, 13, 23], fullSyncIsDefault: true, rawSyncHours: [], rawSyncIsDefault: true, defaultFullHours: [5, 13, 23], defaultRawHours: [], snapshot: false, syncEnabled: true, sineDie: true }],
      }, meta: {} }))
    }
    if (u.includes('/sync/session/10') && init?.method === 'PUT') {
      return new Response(JSON.stringify({ data: { sessionId: 10 }, meta: {} }))
    }
    return new Response('{}')
  })
}

beforeEach(() => { vi.restoreAllMocks(); active = null; mockFetch() })

describe('Settings page', () => {
  it('lists active sessions and shows sine die read-only', async () => {
    render(<MemoryRouter><Settings /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('RI 2026')).toBeInTheDocument())
    expect(screen.getByText('RI 2024')).toBeInTheDocument()
    expect(screen.getByText(/concluded/i)).toBeInTheDocument()
  })

  it('saves an edited schedule via PUT', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    render(<MemoryRouter><Settings /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('RI 2026')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => {
      const putCall = spy.mock.calls.find(c => String(c[0]).includes('/sync/session/10') && (c[1] as any)?.method === 'PUT')
      expect(putCall).toBeTruthy()
    })
  })
})

describe('Settings page: a snapshot session', () => {
  it('shows its provider hours as Default and no raw grid', async () => {
    active = [mdSession()]
    render(<MemoryRouter><Settings /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('MD 2026')).toBeInTheDocument())
    expect(screen.queryByText('Raw sync hours (ET)')).toBeNull()
    expect(screen.getByText('Full sync hours (ET)')).toBeInTheDocument()
    expect(screen.queryByText('(custom)')).toBeNull()
  })

  it('fills the Default preset with the provider hours', async () => {
    active = [mdSession({ fullSyncHours: [6], fullSyncIsDefault: false })]
    const spy = vi.spyOn(globalThis, 'fetch')
    render(<MemoryRouter><Settings /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('MD 2026')).toBeInTheDocument())
    expect(screen.getByText('(custom)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    expect(screen.queryByText('(custom)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => {
      const put = spy.mock.calls.find(c => String(c[0]).includes('/sync/session/10') && (c[1] as any)?.method === 'PUT')
      expect(JSON.parse((put![1] as any).body).fullSyncHoursEt).toEqual(EVERY_HOUR)
    })
  })

  it('keeps the raw grid for a LegiScan session', async () => {
    render(<MemoryRouter><Settings /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('RI 2026')).toBeInTheDocument())
    expect(screen.getByText('Raw sync hours (ET)')).toBeInTheDocument()
    expect(screen.queryByText('(custom)')).toBeNull()
  })
})
