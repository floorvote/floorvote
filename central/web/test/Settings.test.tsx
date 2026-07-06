import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Settings from '../src/pages/Settings'

function mockFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    const u = String(url)
    if (u.includes('/sync/sessions') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ data: {
        active: [{ sessionId: 10, state: 'RI', sessionName: 'RI 2026', yearStart: 2026, yearEnd: 2026, billCount: 3, lastSyncedAt: null, fullSyncHours: [5, 13, 23], fullSyncIsDefault: true, rawSyncHours: [7, 9, 11, 15, 17, 19, 21], rawSyncIsDefault: true, syncEnabled: true, sineDie: false }],
        sineDie: [{ sessionId: 11, state: 'RI', sessionName: 'RI 2024', yearStart: 2024, yearEnd: 2024, billCount: 9, lastSyncedAt: null, fullSyncHours: [5, 13, 23], fullSyncIsDefault: true, rawSyncHours: [], rawSyncIsDefault: true, syncEnabled: true, sineDie: true }],
      }, meta: {} }))
    }
    if (u.includes('/sync/session/10') && init?.method === 'PUT') {
      return new Response(JSON.stringify({ data: { sessionId: 10 }, meta: {} }))
    }
    return new Response('{}')
  })
}

beforeEach(() => { vi.restoreAllMocks(); mockFetch() })

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
