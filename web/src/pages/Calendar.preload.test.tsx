import { it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'

const apiCalls: string[] = []
vi.mock('../lib/api', () => ({
  apiFetch: async (path: string) => {
    apiCalls.push(path)
    if (path === '/config') return { states: ['RI'] }
    if (path === '/calendar/events') return []
    return []
  },
  ApiError: class extends Error {},
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'member' } }) }))

import { Calendar } from './Calendar'

// Fixture uses real CalendarEvent shape — "description" is the rendered title field
// (eventBodyModel derives text from event.description, not a "title" property).
const PRELOADED = [{
  id: 'c1',
  uid: 'uid-c1',
  source: 'hearing',
  description: 'Seeded Hearing',
  date: '2026-02-15',
  time: null,
  location: null,
  details: null,
  url: null,
  billId: null,
  bills: [],
  status: 'confirmed' as const,
}]

it('renders loader-provided calendar events without re-fetching /calendar/events', async () => {
  apiCalls.length = 0
  // The route loader resolves events before render (here from the fixture), so the
  // component seeds from useLoaderData and must not refetch /calendar/events.
  const router = createMemoryRouter(
    [{ path: '/calendar', element: <Calendar />, loader: () => PRELOADED }],
    { initialEntries: ['/calendar'] },
  )
  render(<RouterProvider router={router} />)
  expect(await screen.findByText('Seeded Hearing')).toBeInTheDocument()
  expect(apiCalls).not.toContain('/calendar/events')
})
