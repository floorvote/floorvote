import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

// The Calendar page with and without body-event coverage (#420): one control
// for which committee events show, only where a covered state's provider
// publishes its own calendar, and only for admins, who alone can change it.

const state = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'member',
  calls: [] as string[],
  saved: null as unknown,
}))

const HOUSING = { committeeId: '3000000001', name: 'Committee on Housing', chamber: 'C', state: 'DC' }
const COW = { committeeId: '3000000002', name: 'Committee of the Whole', chamber: 'C', state: 'DC' }
const event = (id: string, description: string, date: string) => ({
  id, uid: `uid-${id}`, source: 'body', description, date, time: null, location: null, details: null, url: null, billId: null, bills: [], status: 'confirmed' as const,
})
const HOUSING_EVENT = event('e1', 'Housing roundtable', '2026-02-15')
const COW_EVENT = event('e2', 'Whole hearing', '2026-02-16')

vi.mock('../lib/api', () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    state.calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/calendar/events') {
      const rules = state.saved as { committees: { committeeId: string }[] } | null
      // What the instance's rules select, as the api decides it.
      return !rules ? [HOUSING_EVENT, COW_EVENT] : [HOUSING_EVENT, COW_EVENT].filter(e => rules.committees.some(c => c.committeeId === (e.id === 'e1' ? HOUSING.committeeId : COW.committeeId)))
    }
    if (path === '/admin/event-rules' && !init?.method) {
      return { rules: state.saved, hasBodyEvents: true, committees: [COW, HOUSING], kinds: [], events: [], optionsError: null }
    }
    if (path === '/admin/event-rules' && init?.method === 'PUT') {
      state.saved = (JSON.parse(String(init.body)) as { rules: unknown }).rules
      return { rules: state.saved, shown: 1, hidden: 1 }
    }
    if (path === '/calendar/info') return { webcalUrl: 'webcal://x', feedUrl: 'https://x', googleUrl: 'https://g' }
    return []
  },
  ApiError: class extends Error {},
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: state.role } }) }))

import { Calendar } from './Calendar'

const COVERED: AppConfig['capabilities'] = { DC: { bodyEvents: true, deadlines: true, bodyName: 'Council' } }
const UNCOVERED: AppConfig['capabilities'] = { MD: { bodyEvents: false, deadlines: true } }

function renderCalendar(capabilities: AppConfig['capabilities'] | undefined) {
  const router = createMemoryRouter(
    [{ path: '/calendar', element: <Calendar />, loader: () => [HOUSING_EVENT, COW_EVENT] }],
    { initialEntries: ['/calendar'] },
  )
  return render(
    <ConfigContext value={{ config: { states: ['DC'], capabilities }, multiState: false, loading: false }}>
      <RouterProvider router={router} />
    </ConfigContext>,
  )
}

// Switching view scrolls the shared container to the top; jsdom has no scrollTo.
let originalScrollTo: typeof Element.prototype.scrollTo
beforeEach(() => {
  state.role = 'admin'; state.calls = []; state.saved = null
  originalScrollTo = Element.prototype.scrollTo
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
})
afterEach(() => { Element.prototype.scrollTo = originalScrollTo })

describe('Calendar page and the committee events control', () => {
  it('shows no control, and asks for no rules, without body-event coverage', async () => {
    renderCalendar(UNCOVERED)
    expect(await screen.findByText('Housing roundtable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Committee events settings' })).not.toBeInTheDocument()
    expect(state.calls).not.toContain('GET /admin/event-rules')
  })

  it('shows no control while the instance has not heard its capabilities yet', async () => {
    renderCalendar(undefined)
    expect(await screen.findByText('Housing roundtable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Committee events settings' })).not.toBeInTheDocument()
  })

  it('shows the committee events gear in the toolbar with coverage, beside Subscribe and Import events', async () => {
    renderCalendar(COVERED)
    const control = await screen.findByRole('button', { name: 'Committee events settings' })
    const toolbar = control.parentElement!
    expect(within(toolbar).getByRole('button', { name: 'Subscribe' })).toBeInTheDocument()
    expect(within(toolbar).getByRole('button', { name: 'Import events' })).toBeInTheDocument()
  })

  it('leaves the control to admins: a member sees none and asks the admin api for nothing', async () => {
    state.role = 'member'
    renderCalendar(COVERED)
    expect(await screen.findByText('Housing roundtable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Committee events settings' })).not.toBeInTheDocument()
    expect(state.calls).not.toContain('GET /admin/event-rules')
  })

  it('treats an owner as an admin', async () => {
    state.role = 'owner' as never
    renderCalendar(COVERED)
    expect(await screen.findByRole('button', { name: 'Committee events settings' })).toBeInTheDocument()
  })

  it('shows only the chosen committees\' events once they are chosen', async () => {
    renderCalendar(COVERED)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Committee events settings' }))
    const menu = await screen.findByRole('dialog', { name: 'Committee events' })
    await user.click(within(menu).getByRole('radio', { name: 'Only these committees' }))
    await user.click(await within(menu).findByRole('checkbox', { name: 'Committee on Housing' }))
    await waitFor(() => expect(screen.queryByText('Whole hearing')).not.toBeInTheDocument())
    expect(screen.getByText('Housing roundtable')).toBeInTheDocument()
    // Back to every event: both are listed again.
    await user.click(within(menu).getByRole('radio', { name: 'All events' }))
    expect(await screen.findByText('Whole hearing')).toBeInTheDocument()
    expect(state.calls.filter(c => c === 'GET /calendar/events').length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the same control and the same choice from Agenda to Month and back', async () => {
    state.saved = { committees: [{ committeeId: HOUSING.committeeId, name: HOUSING.name }], kinds: [], topics: [], trackedBills: false }
    renderCalendar(COVERED)
    const user = userEvent.setup()
    expect(await screen.findByRole('button', { name: 'Committee events settings' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Month' }))
    expect(screen.getAllByRole('button', { name: 'Committee events settings' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Committee events settings' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Agenda' }))
    expect(screen.getAllByRole('button', { name: 'Committee events settings' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Committee events settings' })).toBeInTheDocument()
    // Editing in one view is what the other reads: one fetch of the rules in all.
    expect(state.calls.filter(c => c === 'GET /admin/event-rules')).toHaveLength(1)
  })

  it('shows a rule saved earlier in the control\'s menu, and its Remove works from the Calendar page', async () => {
    state.saved = { committees: [{ committeeId: HOUSING.committeeId, name: HOUSING.name }], kinds: ['meeting'], topics: [], trackedBills: true }
    renderCalendar(COVERED)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Committee events settings' }))
    const menu = await screen.findByRole('dialog', { name: 'Committee events' })
    expect(within(menu).getByText(/^Kept from an earlier setting:/)).toBeInTheDocument()
    await user.click(within(menu).getByRole('button', { name: /^Remove/ }))
    await waitFor(() => expect(state.saved).toEqual({ committees: [{ committeeId: HOUSING.committeeId, name: HOUSING.name }], kinds: [], topics: [], trackedBills: false }))
    await waitFor(() => expect(within(menu).queryByText(/Kept from an earlier setting/)).not.toBeInTheDocument())
  })
})
