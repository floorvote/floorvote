import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
const BOUNCED_NO_INVITER = { ...base, id: 'n-1', email: 'noinviter@example.com', name: 'Uninvited Bounce', hasLoggedIn: false, invitedBy: null, emailBounce: { reason: 'user unknown' } }
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

  it('shows a red "Email bounced" label in place of "Invite pending"', async () => {
    mockApi([OWNER, BOUNCED])
    renderMembers()

    const cell = await statusCell('Bounced Invite')
    const label = within(cell).getByText('Email bounced')
    expect(label).toHaveStyle({ color: color.textDanger, background: color.bgDangerSoft })
    expect(within(cell).queryByText('Invite pending')).not.toBeInTheDocument()
  })

  it('reveals the reason on mouse hover', async () => {
    mockApi([OWNER, BOUNCED])
    renderMembers()

    const trigger = within(await statusCell('Bounced Invite')).getByRole('button', { name: /email bounced/i })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('550 5.1.1 user unknown')
  })

  it('reveals the reason on tap, so it is reachable on a touch screen, and links it via aria-describedby', async () => {
    const user = userEvent.setup()
    mockApi([OWNER, BOUNCED])
    renderMembers()

    const trigger = within(await statusCell('Bounced Invite')).getByRole('button', { name: /email bounced/i })
    // A touch pointerenter alone must not be what reveals it; the tap (click) does.
    fireEvent.pointerEnter(trigger, { pointerType: 'touch' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.click(trigger)
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('550 5.1.1 user unknown')
    expect(trigger).toHaveAttribute('aria-describedby', tip.id)

    await user.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('reveals the reason on keyboard focus', async () => {
    mockApi([OWNER, BOUNCED])
    renderMembers()

    const trigger = within(await statusCell('Bounced Invite')).getByRole('button', { name: /email bounced/i })
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('550 5.1.1 user unknown')
  })

  it('gives a generic reason when the provider gave none', async () => {
    const user = userEvent.setup()
    mockApi([OWNER, BOUNCED_NO_REASON])
    renderMembers()

    await user.click(within(await statusCell('Reasonless Bounce')).getByRole('button', { name: /email bounced/i }))
    expect(screen.getByRole('tooltip').textContent).toMatch(/couldn't be delivered/i)
  })

  it('never labels a member with no inviter "Email bounced", even if the API reports a bounce', async () => {
    mockApi([OWNER, BOUNCED_NO_INVITER])
    renderMembers()

    const cell = await statusCell('Uninvited Bounce')
    expect(within(cell).queryByText('Email bounced')).not.toBeInTheDocument()
    expect(within(cell).queryByText('Invite pending')).not.toBeInTheDocument()
    expect(within(cell).getByText('Active')).toBeInTheDocument()
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
