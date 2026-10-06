import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { color } from '../../styles/tokens'

const base = {
  role: 'member' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  roles: [],
  canVote: true,
  voteCount: 0,
  loginTrouble: false,
  emailBounce: null as { reason: string | null } | null,
}

const OWNER = { ...base, id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' as const, hasLoggedIn: true, invitedBy: null }
const inviter = { id: 'owner-1', name: 'Sole Owner', email: 'owner@example.com' }

const BOUNCED = { ...base, id: 'b-1', email: 'typo@example.com', name: 'Bounced Invite', hasLoggedIn: false, invitedBy: inviter, emailBounce: { reason: '550 5.1.1 user unknown' } }
const BOUNCED_NO_REASON = { ...base, id: 'b-2', email: 'quiet@example.com', name: 'Reasonless Bounce', hasLoggedIn: false, invitedBy: inviter, emailBounce: { reason: null } }
const PENDING = { ...base, id: 'p-1', email: 'pending@example.com', name: 'Pending Invite', hasLoggedIn: false, invitedBy: inviter }
const ACTIVE = { ...base, id: 'a-1', email: 'active@example.com', name: 'Active Member', hasLoggedIn: true, invitedBy: inviter }
const DEACTIVATED_BOUNCED = { ...base, id: 'd-1', email: 'gone@example.com', name: 'Gone Member', hasLoggedIn: false, invitedBy: inviter, deactivatedAt: '2024-02-01T00:00:00Z', emailBounce: { reason: 'user unknown' } }

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApi(members: unknown[]) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return members as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
}

async function statusCell(name: string) {
  const row = (await screen.findByText(name)).closest('tr')!
  return row.querySelector('td[data-label="Status"]') as HTMLElement
}

function renderMembers() {
  render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>,
  )
}

describe('Members "Email bounced" status', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows a red "Email bounced" label with the reason on hover in place of "Invite pending"', async () => {
    mockApi([OWNER, BOUNCED])
    renderMembers()

    const cell = await statusCell('Bounced Invite')
    const label = within(cell).getByText('Email bounced')
    expect(label).toHaveAttribute('title', '550 5.1.1 user unknown')
    expect(label).toHaveStyle({ color: color.textDanger, background: color.bgDangerSoft })
    expect(within(cell).queryByText('Invite pending')).not.toBeInTheDocument()
  })

  it('gives a generic hover text when the provider gave no reason', async () => {
    mockApi([OWNER, BOUNCED_NO_REASON])
    renderMembers()

    const label = within(await statusCell('Reasonless Bounce')).getByText('Email bounced')
    expect(label.getAttribute('title')).toMatch(/couldn't be delivered/i)
  })

  it('keeps the amber "Invite pending" label for a pending invite whose email did not bounce', async () => {
    mockApi([OWNER, PENDING, BOUNCED])
    renderMembers()

    const cell = await statusCell('Pending Invite')
    const label = within(cell).getByText('Invite pending')
    expect(label).toHaveStyle({ color: color.textAmberDark, background: color.bgWarnSoft })
    expect(within(cell).queryByText('Email bounced')).not.toBeInTheDocument()
  })

  it('treats a member with no emailBounce field as pending (older API response)', async () => {
    const { emailBounce: _omit, ...legacy } = PENDING
    mockApi([OWNER, legacy])
    renderMembers()

    expect(within(await statusCell('Pending Invite')).getByText('Invite pending')).toBeInTheDocument()
  })

  it('shows "Deactivated", not "Email bounced", for a deactivated member', async () => {
    mockApi([OWNER, DEACTIVATED_BOUNCED])
    renderMembers()

    const cell = await statusCell('Gone Member')
    expect(within(cell).getByText('Deactivated')).toBeInTheDocument()
    expect(within(cell).queryByText('Email bounced')).not.toBeInTheDocument()
  })

  it('shows "Active" for a signed-in member', async () => {
    mockApi([OWNER, ACTIVE, BOUNCED])
    renderMembers()

    const cell = await statusCell('Active Member')
    expect(within(cell).getByText('Active')).toBeInTheDocument()
    expect(within(cell).queryByText('Email bounced')).not.toBeInTheDocument()
  })

  it('renders the label inside the labeled Status cell that the phone card layout shows', async () => {
    mockApi([OWNER, BOUNCED])
    renderMembers()

    const cell = await statusCell('Bounced Invite')
    expect(cell).toHaveAttribute('data-label', 'Status')
    expect(within(cell).getByText('Email bounced')).toBeVisible()
  })
})
