import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

const OWNER = {
  id: 'owner-1',
  email: 'owner@example.com',
  name: 'Sole Owner',
  role: 'owner' as const,
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

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

type Summary = { invited: number; exists: number; duplicate: number; invalid: number }

function mockApi(summary: Summary) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return [OWNER] as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    if (path === '/admin/members/bulk-invite') return { summary, results: [] } as never
    return {} as never
  })
}

async function invite(summary: Summary): Promise<string> {
  mockApi(summary)
  render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Invitees'), { target: { value: 'someone@example.com' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send invites' }))
  return (await screen.findByText(/\d+ invited/)).textContent ?? ''
}

const NONE: Summary = { invited: 0, exists: 0, duplicate: 0, invalid: 0 }

describe('Members invite summary', () => {
  beforeEach(() => vi.restoreAllMocks())

  it.each([
    [{ ...NONE, exists: 1 }, '0 invited · 1 already a member'],
    [{ ...NONE, exists: 2 }, '0 invited · 2 already members'],
    [{ ...NONE, invited: 1, duplicate: 1 }, '1 invited · 1 duplicate'],
    [{ ...NONE, invited: 1, duplicate: 3 }, '1 invited · 3 duplicates'],
    [{ ...NONE, invited: 2, invalid: 1 }, '2 invited · 1 invalid'],
    [{ invited: 1, exists: 1, duplicate: 1, invalid: 1 }, '1 invited · 1 already a member · 1 duplicate · 1 invalid'],
    [{ invited: 3, exists: 4, duplicate: 2, invalid: 5 }, '3 invited · 4 already members · 2 duplicates · 5 invalid'],
  ])('reads naturally for %o', async (summary, expected) => {
    expect(await invite(summary)).toBe(expected)
  })
})
