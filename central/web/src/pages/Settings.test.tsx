import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const EVERY_HOUR = Array.from({ length: 24 }, (_, h) => h)
const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 1, state: 'MD', sessionName: 'MD 2026', yearStart: 2026, yearEnd: 2026, billCount: 3,
  lastSyncedAt: null, fullSyncHours: EVERY_HOUR, fullSyncIsDefault: true,
  rawSyncHours: [7, 9], rawSyncIsDefault: true, syncEnabled: true, sineDie: false,
  defaultFullHours: EVERY_HOUR, defaultRawHours: [], snapshot: true, ...over,
})

let rows: unknown[] = []
let saved: { path: string; body: string }[] = []
vi.mock('../lib/api', () => ({
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PUT') { saved.push({ path, body: init.body ?? '' }); return {} }
    return { active: rows, sineDie: [] }
  },
}))

import Settings from './Settings'

describe('Settings: snapshot session', () => {
  beforeEach(() => { saved = [] })

  it('shows the provider hours as Default and no raw grid', async () => {
    rows = [session()]
    render(<Settings />)
    await screen.findByText(/MD 2026/)
    expect(screen.queryByText('Raw sync hours (ET)')).toBeNull()
    expect(screen.getByText('Full sync hours (ET)')).toBeInTheDocument()
    expect(screen.queryByText('(custom)')).toBeNull()
  })

  it('fills the Default preset with the provider hours', async () => {
    rows = [session({ fullSyncHours: [6], fullSyncIsDefault: false })]
    render(<Settings />)
    await screen.findByText(/MD 2026/)
    expect(screen.getByText('(custom)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Default' }))
    expect(screen.queryByText('(custom)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(JSON.parse(saved[0].body).fullSyncHoursEt).toEqual(EVERY_HOUR)
  })

  it('keeps the raw grid for a LegiScan session', async () => {
    rows = [session({ state: 'RI', sessionName: 'RI 2026', snapshot: false,
      defaultFullHours: [5, 13, 23], defaultRawHours: [7, 9, 11, 15, 17, 19, 21],
      fullSyncHours: [5, 13, 23], rawSyncHours: [7, 9, 11, 15, 17, 19, 21] })]
    render(<Settings />)
    await screen.findByText(/RI 2026/)
    expect(screen.getByText('Raw sync hours (ET)')).toBeInTheDocument()
    expect(screen.queryByText('(custom)')).toBeNull()
  })
})
