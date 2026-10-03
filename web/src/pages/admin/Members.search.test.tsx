import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

// Search on the Members page matches name, email, Role names, and the displayed
// permission label. An Owner also matches any query inside "admin". Subtitle
// never matches.

const FINANCE = { id: 'role-fin', name: 'Finance Committee' }
const OUTREACH = { id: 'role-out', name: 'Outreach' }

type Fixture = { id: string; email: string; name: string; role?: 'owner' | 'admin' | 'member' } & Record<string, unknown>

function member(overrides: Fixture) {
  return {
    subtitle: null,
    createdAt: '2024-01-01T00:00:00Z',
    lastActive: '2024-01-01T00:00:00Z',
    deactivatedAt: null,
    hasLoggedIn: true,
    invitedBy: null,
    roles: [],
    canVote: true,
    voteCount: 0,
    loginTrouble: false,
    role: 'member' as const,
    ...overrides,
  }
}

const OWNER = member({ id: 'owner-1', email: 'olivia@example.com', name: 'Olivia Owner', role: 'owner' })
const ADMIN = member({ id: 'admin-1', email: 'avery@example.com', name: 'Avery Admin', role: 'admin', roles: [FINANCE] })
// Multiple Roles.
const FRAN = member({ id: 'fran-1', email: 'fran@example.com', name: 'Fran Frost', roles: [FINANCE, OUTREACH] })
// Zero Roles; subtitle mentions finance but must not match.
const NORA = member({ id: 'nora-1', email: 'nora@example.com', name: 'Nora North', subtitle: 'Finance Director' })
// Email contains "finance" but holds no Role.
const ELI = member({ id: 'eli-1', email: 'finance.desk@example.com', name: 'Eli East' })
// Login trouble, in Outreach.
const TOBY = member({ id: 'toby-1', email: 'toby@example.com', name: 'Toby Trent', roles: [OUTREACH], loginTrouble: true })

const MEMBERS = [OWNER, ADMIN, FRAN, NORA, ELI, TOBY]
const ALL_EMAILS = MEMBERS.map(m => m.email)

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'olivia@example.com', name: 'Olivia Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApi() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return MEMBERS as never
    if (path === '/admin/roles') return [FINANCE, OUTREACH] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
}

const PLACEHOLDER = 'Search by name, email, role, or permission level…'

async function renderPage() {
  mockApi()
  render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
  await screen.findByText('Toby Trent')
}

function search(q: string) {
  fireEvent.change(screen.getByPlaceholderText(PLACEHOLDER), { target: { value: q } })
}

// Emails of the Members whose rows are currently in the table, sorted.
function shownEmails(): string[] {
  const rows = screen.getAllByRole('row')
  return ALL_EMAILS.filter(email => rows.some(r => r.textContent?.includes(email))).sort()
}

function emails(...ms: { email: string }[]): string[] {
  return ms.map(m => m.email).sort()
}

describe('Members search', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows the new placeholder', async () => {
    await renderPage()
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument()
  })

  it('shows everyone with an empty or whitespace-only query', async () => {
    await renderPage()
    expect(shownEmails()).toEqual([...ALL_EMAILS].sort())
    search('   ')
    expect(shownEmails()).toEqual([...ALL_EMAILS].sort())
    expect(screen.getByText(/6 members/)).toBeInTheDocument()
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument()
  })

  describe('regression: name and email', () => {
    it('matches by display name', async () => {
      await renderPage()
      search('nora')
      expect(shownEmails()).toEqual(emails(NORA))
    })

    it('matches by email', async () => {
      await renderPage()
      search('toby@')
      expect(shownEmails()).toEqual(emails(TOBY))
    })

    it('trims surrounding whitespace', async () => {
      await renderPage()
      search('  Nora  ')
      expect(shownEmails()).toEqual(emails(NORA))
    })
  })

  describe('Role names', () => {
    it('matches an exact Role name, including Members with several Roles', async () => {
      await renderPage()
      search('Outreach')
      expect(shownEmails()).toEqual(emails(FRAN, TOBY))
    })

    it('matches a partial, mixed-case Role name', async () => {
      await renderPage()
      search('cOMMit')
      expect(shownEmails()).toEqual(emails(ADMIN, FRAN))
    })

    it('matches a Role name on one Member and an unrelated email on another (accepted imprecision)', async () => {
      await renderPage()
      search('finance')
      // Avery and Fran hold the Role; Eli only has "finance" in their email.
      expect(shownEmails()).toEqual(emails(ADMIN, FRAN, ELI))
    })

    it('does not match a Member with zero Roles through their subtitle', async () => {
      await renderPage()
      search('director')
      expect(shownEmails()).toEqual([])
      expect(screen.getByText(/Showing 0 of 6/)).toBeInTheDocument()
    })
  })

  describe('permission level', () => {
    it('"admin" shows Admins and Owners', async () => {
      await renderPage()
      search('admin')
      expect(shownEmails()).toEqual(emails(OWNER, ADMIN))
    })

    it('"Admin" in a different case behaves the same', async () => {
      await renderPage()
      search('ADMIN')
      expect(shownEmails()).toEqual(emails(OWNER, ADMIN))
    })

    it('an Owner matches a partial "adm"', async () => {
      await renderPage()
      search('adm')
      expect(shownEmails()).toEqual(emails(OWNER, ADMIN))
    })

    it('an Owner matches a fragment from the middle of "admin"', async () => {
      await renderPage()
      search('dmi')
      expect(shownEmails()).toEqual(emails(OWNER, ADMIN))
    })

    it('"owner" shows only Owners, not Admins', async () => {
      await renderPage()
      search('owner')
      expect(shownEmails()).toEqual(emails(OWNER))
    })

    it('"member" matches Standard members by their displayed label', async () => {
      await renderPage()
      search('member')
      expect(shownEmails()).toEqual(emails(FRAN, NORA, ELI, TOBY))
    })
  })

  describe('count line', () => {
    it('shows "Showing X of Y" while a search is active', async () => {
      await renderPage()
      search('admin')
      expect(screen.getByText(/Showing 2 of 6/)).toBeInTheDocument()
    })
  })

  describe('with the login-trouble toggle', () => {
    it('combines search with the toggle', async () => {
      await renderPage()
      fireEvent.click(screen.getByText(/1 member with login trouble/i))
      expect(shownEmails()).toEqual(emails(TOBY))

      search('outreach')
      // Fran is in Outreach but has no login trouble.
      expect(shownEmails()).toEqual(emails(TOBY))
      expect(screen.getByText(/Showing 1 of 6/)).toBeInTheDocument()

      search('admin')
      expect(shownEmails()).toEqual([])
      expect(screen.getByText(/Showing 0 of 6/)).toBeInTheDocument()
    })
  })
})
