import { it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

// Regression pin: on a DEMO_MODE tenant, the admin calendar's per-event
// Delete/Restore controls must render with the real HTML `disabled` attribute
// set — not merely styled to look inert — so a demo visitor never hits a 403
// from a click that looked live. (Task 8 critical finding: these had zero
// demoLocked gating.)
vi.mock('../lib/api', () => ({
  apiFetch: async (path: string) => {
    if (path === '/config') return { states: ['RI'] }
    if (path === '/calendar/events') return []
    if (path === '/calendar/bill-options') return []
    return []
  },
  ApiError: class extends Error {},
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin' } }) }))
vi.mock('../context/DemoContext', () => ({ useDemo: () => ({ demoMode: true, demoLocked: true }) }))

import { Calendar } from './Calendar'

const CUSTOM_EVENTS = [
  {
    id: 'ev1',
    uid: 'uid-ev1',
    source: 'custom',
    description: 'Board meeting',
    date: '2026-02-15',
    time: null,
    location: null,
    details: null,
    url: null,
    billId: null,
    bills: [],
    status: 'confirmed' as const,
  },
  {
    id: 'ev2',
    uid: 'uid-ev2',
    source: 'custom',
    description: 'Cancelled session',
    date: '2026-02-16',
    time: null,
    location: null,
    details: null,
    url: null,
    billId: null,
    bills: [],
    status: 'cancelled' as const,
  },
]

function renderDemoCalendar() {
  const router = createMemoryRouter(
    [{ path: '/calendar', element: <Calendar />, loader: () => CUSTOM_EVENTS }],
    { initialEntries: ['/calendar'] },
  )
  return render(<RouterProvider router={router} />)
}

it('disables the agenda Delete button for admins in a locked demo', async () => {
  renderDemoCalendar()
  expect(await screen.findByText('Board meeting')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /delete event/i })).toBeDisabled()
})

it('disables the agenda Restore button for admins in a locked demo', async () => {
  renderDemoCalendar()
  expect(await screen.findByText('Cancelled session')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /restore event/i })).toBeDisabled()
})

it('still shows the Edit button enabled (edit is gated at Save, not here)', async () => {
  renderDemoCalendar()
  expect(await screen.findByText('Board meeting')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /edit event/i })).not.toBeDisabled()
})
