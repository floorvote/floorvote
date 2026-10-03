import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

// A member with no name (never set, or cleared under #233) shows by email in
// the admin Members table: in the name cell, in search, and in row labels.

const base = {
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: null,
  roles: [],
  canVote: true,
  voteCount: 0,
}

const SELF = { ...base, id: 'admin-1', email: 'self@example.com', name: 'Self Admin', role: 'admin' as const }
const NAMED = { ...base, id: 'm-1', email: 'named@example.com', name: 'Named Member', role: 'member' as const }
const CLEARED = { ...base, id: 'm-2', email: 'cleared@example.com', name: '', role: 'member' as const }

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', email: 'self@example.com', name: 'Self Admin', role: 'admin' },
    loading: false,
  }),
}))

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

function renderMembers() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [SELF, NAMED, CLEARED] as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
  return render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
}

function rowFor(email: string): HTMLElement {
  return screen.getAllByRole('row').find(r => r.textContent?.includes(email)) as HTMLElement
}

afterEach(() => { vi.restoreAllMocks() })

describe('Members table, member with no name', () => {
  it('shows the email in the name cell, once, as a mailto link', async () => {
    renderMembers()
    await screen.findByText('Named Member')
    const cell = rowFor('cleared@example.com').querySelector('td.members-name-cell') as HTMLElement
    expect(within(cell).getAllByRole('link')).toHaveLength(1)
    expect(within(cell).getByRole('link', { name: 'cleared@example.com' })).toHaveAttribute('href', 'mailto:cleared@example.com')
    expect(cell.textContent?.split('cleared@example.com')).toHaveLength(2)
  })

  it('labels the row actions menu with the email', async () => {
    renderMembers()
    await screen.findByText('Named Member')
    const user = userEvent.setup()
    await user.click(within(rowFor('cleared@example.com')).getByRole('button', { name: '···' }))
    expect(await screen.findByRole('menu', { name: 'Actions for cleared@example.com' })).toBeInTheDocument()
  })

  it('finds the member by searching their email', async () => {
    renderMembers()
    await screen.findByText('Named Member')
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText(/search members by name or email/i), 'cleared')
    expect(screen.getByRole('link', { name: 'cleared@example.com' })).toBeInTheDocument()
    expect(screen.queryByText('Named Member')).not.toBeInTheDocument()
  })
})
