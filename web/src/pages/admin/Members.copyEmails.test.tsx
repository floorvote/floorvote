import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'

// "Copy N emails" on the Members count line (#236). Renders the page with
// mocked API data and a mocked navigator.clipboard, then asserts what an
// Admin sees and what lands on the clipboard. No helper is called directly.

type TestMember = {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'member'
  subtitle: string | null
  createdAt: string
  lastActive: string
  deactivatedAt: string | null
  hasLoggedIn: boolean
  invitedBy: null
  roles: { id: string; name: string }[]
  canVote: boolean
  voteCount: number
  loginTrouble: boolean
}

function member(overrides: Partial<TestMember> & Pick<TestMember, 'id' | 'email' | 'name'>): TestMember {
  return {
    role: 'member',
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
    ...overrides,
  }
}

const OWNER = member({ id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' })
const ADMIN = member({ id: 'admin-1', email: 'admin@example.com', name: 'Alpha Admin', role: 'admin' })
const ACTIVE = member({ id: 'active-1', email: 'active@example.com', name: 'Active Member' })
const INVITEE = member({ id: 'invitee-1', email: 'invitee@example.com', name: 'Pending Invitee', hasLoggedIn: false })
const DEACTIVATED = member({ id: 'gone-1', email: 'gone@example.com', name: 'Gone Member', deactivatedAt: '2024-02-01T00:00:00Z' })
const TROUBLE = member({ id: 'trouble-1', email: 'trouble@example.com', name: 'Trouble Member', loginTrouble: true })
const TROUBLE_OTHER = member({ id: 'trouble-2', email: 'zeta-trouble@example.com', name: 'Zeta Trouble', loginTrouble: true })

let currentMembers: TestMember[] = []

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApi(members: TestMember[]) {
  currentMembers = members
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return currentMembers as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
}

let writeText: ReturnType<typeof vi.fn>

function mockClipboard(impl?: (text: string) => Promise<void>) {
  writeText = vi.fn(impl ?? (async () => {}))
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
}

async function renderPage(members: TestMember[]) {
  mockApi(members)
  render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
  await screen.findByText(members[0].name)
}

function search(q: string) {
  fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: q } })
}

function copyButton() {
  return screen.getByRole('button', { name: /^copy \d+ emails?$/i })
}

function copiedEmails(): string[] {
  expect(writeText).toHaveBeenCalledTimes(1)
  return (writeText.mock.calls[0][0] as string).split(', ')
}

describe('Members copy shown emails', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockClipboard()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the button on the count line and copies every shown email, comma-and-space separated', async () => {
    await renderPage([OWNER, ADMIN, ACTIVE])
    const btn = copyButton()
    expect(btn).toHaveTextContent('Copy 3 emails')
    // Lives on the count line alongside "3 members".
    expect(btn.parentElement).toHaveTextContent('3 members')

    fireEvent.click(btn)
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toBe(
      // Order follows the table: owners, admins, then members.
      'owner@example.com, admin@example.com, active@example.com',
    )
  })

  it('excludes deactivated members from both the count and the clipboard', async () => {
    await renderPage([OWNER, ACTIVE, DEACTIVATED])
    // The deactivated member is still shown in the list…
    expect(screen.getByText('Gone Member')).toBeInTheDocument()
    // …but not counted or copied.
    expect(copyButton()).toHaveTextContent('Copy 2 emails')
    fireEvent.click(copyButton())
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(copiedEmails()).toEqual(['owner@example.com', 'active@example.com'])
  })

  it('includes invited members who have never logged in', async () => {
    await renderPage([OWNER, INVITEE])
    expect(copyButton()).toHaveTextContent('Copy 2 emails')
    fireEvent.click(copyButton())
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(copiedEmails()).toContain('invitee@example.com')
  })

  it('de-duplicates emails that appear on more than one row, counting each address once', async () => {
    const dupe = member({ id: 'dupe-1', email: 'ACTIVE@example.com', name: 'Duplicate Row' })
    const exact = member({ id: 'dupe-2', email: 'active@example.com', name: 'Exact Duplicate' })
    await renderPage([OWNER, ACTIVE, exact, dupe])
    expect(copyButton()).toHaveTextContent('Copy 2 emails')
    fireEvent.click(copyButton())
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const emails = copiedEmails()
    expect(emails).toHaveLength(2)
    expect(emails.map(e => e.toLowerCase())).toEqual(['owner@example.com', 'active@example.com'])
  })

  it('uses the singular label when exactly one email will be copied', async () => {
    await renderPage([OWNER, ACTIVE])
    search('active')
    expect(copyButton()).toHaveTextContent(/^Copy 1 email$/)
  })

  it('makes the button unavailable when every shown member is deactivated', async () => {
    await renderPage([OWNER, DEACTIVATED])
    search('gone')
    expect(screen.getByText('Gone Member')).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: /^copy 0 emails$/i })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('makes the button unavailable when the search matches nobody', async () => {
    await renderPage([OWNER, ACTIVE])
    search('no-such-person')
    expect(screen.getByText('Showing 0 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^copy 0 emails$/i })).toBeDisabled()
  })

  it('counts only active members when active and deactivated are mixed in the results', async () => {
    const riverActive = member({ id: 'river-1', email: 'river-one@example.com', name: 'River One' })
    const riverInvitee = member({ id: 'river-2', email: 'river-two@example.com', name: 'River Two', hasLoggedIn: false })
    const riverGone = member({ id: 'river-3', email: 'river-three@example.com', name: 'River Three', deactivatedAt: '2024-03-01T00:00:00Z' })
    await renderPage([OWNER, ACTIVE, riverActive, riverInvitee, riverGone])
    search('river')
    expect(screen.getByText('Showing 3 of 5')).toBeInTheDocument()
    expect(screen.getByText('River Three')).toBeInTheDocument()
    expect(copyButton()).toHaveTextContent('Copy 2 emails')
    fireEvent.click(copyButton())
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(copiedEmails()).toEqual(['river-one@example.com', 'river-two@example.com'])
  })

  it('updates the label as the search changes', async () => {
    await renderPage([OWNER, ADMIN, ACTIVE, INVITEE])
    expect(copyButton()).toHaveTextContent('Copy 4 emails')
    search('a')
    // Every fixture name or email has an "a"; Sole Owner's email "owner@example.com" has one too.
    expect(copyButton()).toHaveTextContent('Copy 4 emails')
    search('alpha')
    expect(copyButton()).toHaveTextContent(/^Copy 1 email$/)
    search('xyz-nobody')
    expect(screen.getByRole('button', { name: /^copy 0 emails$/i })).toBeDisabled()
    search('')
    expect(copyButton()).toHaveTextContent('Copy 4 emails')
  })

  it('respects the login-trouble toggle alone', async () => {
    await renderPage([OWNER, ACTIVE, TROUBLE, TROUBLE_OTHER])
    expect(copyButton()).toHaveTextContent('Copy 4 emails')
    fireEvent.click(screen.getByText(/2 members with login trouble/i))
    expect(copyButton()).toHaveTextContent('Copy 2 emails')
    fireEvent.click(copyButton())
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(copiedEmails().sort()).toEqual(['trouble@example.com', 'zeta-trouble@example.com'])
  })

  it('respects search and the login-trouble toggle combined', async () => {
    await renderPage([OWNER, ACTIVE, TROUBLE, TROUBLE_OTHER])
    fireEvent.click(screen.getByText(/2 members with login trouble/i))
    search('zeta')
    expect(screen.getByText('Showing 1 of 4')).toBeInTheDocument()
    expect(copyButton()).toHaveTextContent(/^Copy 1 email$/)
    fireEvent.click(copyButton())
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(copiedEmails()).toEqual(['zeta-trouble@example.com'])
  })

  it('shows a brief "Copied" confirmation on success that clears on its own', async () => {
    await renderPage([OWNER, ACTIVE])
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(copyButton())
    })
    expect(screen.getByText('Copied')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })

  it('shows an inline error and no "Copied" when the clipboard write fails', async () => {
    mockClipboard(async () => {
      throw new Error('denied')
    })
    await renderPage([OWNER, ACTIVE])
    fireEvent.click(copyButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t copy/i)
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })

  it('shows an inline error when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true })
    await renderPage([OWNER, ACTIVE])
    fireEvent.click(copyButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t copy/i)
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })
})
