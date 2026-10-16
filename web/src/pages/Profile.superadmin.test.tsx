import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// A superadmin's name and title are kept in central and refreshed at each
// sign-in, so the instance's Profile page shows them read-only with a note
// pointing at the admin dashboard.

const auth = vi.hoisted(() => ({ isSuperadmin: true, name: 'Ada Lovelace', title: 'Operator support' as string | null, dashboardUrl: undefined as string | undefined }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'ada@operator.example', name: auth.name, role: 'admin', title: auth.title,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
      isLastOwner: false, isSuperadmin: auth.isSuperadmin,
    },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition', centralDashboardUrl: auth.dashboardUrl }, multiState: false, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

function setup() {
  render(<MemoryRouter><Profile /></MemoryRouter>)
  return screen.getByRole('heading', { level: 1, name: 'Profile' }).parentElement as HTMLElement
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'apiFetch').mockResolvedValue({} as never)
  auth.isSuperadmin = true
  auth.name = 'Ada Lovelace'
  auth.title = 'Operator support'
  auth.dashboardUrl = undefined
})

describe('Profile page for a superadmin', () => {
  it('shows name and title as plain text, not editable fields', () => {
    const card = setup()
    expect(within(card).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(card).getByText('Operator support')).toBeInTheDocument()
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /^save/i })).not.toBeInTheDocument()
  })

  it('says they are managed in the admin dashboard', () => {
    const card = setup()
    expect(within(card).getByText(/managed in the admin dashboard/i)).toBeInTheDocument()
  })

  it('links the admin dashboard to its Your Profile page, in a new tab, when the instance knows the address', () => {
    auth.dashboardUrl = 'https://admin.example.com'
    const card = setup()
    const link = within(card).getByRole('link', { name: /admin dashboard/i })
    expect(link).toHaveAttribute('href', 'https://admin.example.com/profile')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('leaves the note as plain text, with no link, when the address is unknown', () => {
    const card = setup()
    expect(within(card).getByText(/managed in the admin dashboard/i)).toBeInTheDocument()
    expect(within(card).queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows a dash for a name or title central has not set', () => {
    auth.name = ''
    auth.title = null
    const card = setup()
    expect(within(card).getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('leaves the preferences below the card editable', () => {
    setup()
    expect(screen.getByRole('switch', { name: /email digest of recent bill activity/i })).toBeEnabled()
  })
})

describe('Profile page for everyone else', () => {
  it('keeps the editable name and title fields and no dashboard note', () => {
    auth.isSuperadmin = false
    const card = setup()
    expect(within(card).getAllByRole('textbox')).toHaveLength(2)
    expect(within(card).getByRole('button', { name: /^save$/i })).toBeInTheDocument()
    expect(screen.queryByText(/managed in the admin dashboard/i)).not.toBeInTheDocument()
  })
})
