import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import { REQUIRED_MESSAGE } from '../../components/RequiredField'
import { color } from '../../styles/tokens'

const UNCHANGED = "That's already their address. Check it for a typo, or use Resend invite to send to it again."
const IN_USE = 'Another member already uses that address.'
const SUPPRESSED = 'This address has bounced before. Check it for a typo.'
const INVALID = 'Invalid email address'

function member(overrides: Record<string, unknown>) {
  return {
    email: 'x@example.com',
    name: 'Someone',
    role: 'member' as const,
    subtitle: null,
    createdAt: '2024-01-01T00:00:00Z',
    lastActive: '2024-01-01T00:00:00Z',
    deactivatedAt: null,
    hasLoggedIn: true,
    invitedBy: { id: 'owner-1', name: 'Sole Owner', email: 'owner@example.com' },
    roles: [],
    canVote: true,
    voteCount: 0,
    ...overrides,
  }
}

const OWNER = member({ id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner', invitedBy: null })
const PENDING = member({ id: 'pending-1', email: 'jane@exmaple.com', name: 'Jane Pending', hasLoggedIn: false })

const authState = vi.hoisted(() => ({
  user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' as 'owner' | 'admin' },
}))
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}))

const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

type Handler = (init?: RequestInit) => unknown
function mockApi(members: unknown[] = [OWNER, PENDING], handlers: Record<string, Handler> = {}) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/members') return members as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    const handler = handlers[path]
    if (handler) return handler(init) as never
    return {} as never
  })
}

function renderMembers() {
  return render(<MemoryRouter><Members /></MemoryRouter>)
}

async function openMenuFor(name: string) {
  const row = (await screen.findByText(name)).closest('tr')!
  fireEvent.click(within(row).getByRole('button', { name: '···' }))
  return screen.findByRole('menu')
}

async function openDialog(name = 'Jane Pending') {
  const menu = await openMenuFor(name)
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Change email…' }))
  return screen.findByRole('dialog', { name: 'Change email' })
}

function changeEmailCalls(spy: ReturnType<typeof mockApi>) {
  return spy.mock.calls.filter(c => String(c[0]).endsWith('/change-email'))
}

describe('Members "Change email…" action', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    authState.user = { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' }
    demoState.demoLocked = false
  })

  describe('where it appears', () => {
    it('appears exactly where "Resend invite" does', async () => {
      const rows = [
        OWNER,
        PENDING,
        member({ id: 'in-1', email: 'in@example.com', name: 'Signed In' }),
        member({ id: 'gone-1', email: 'gone@example.com', name: 'Gone Pending', hasLoggedIn: false, deactivatedAt: '2024-02-01T00:00:00Z' }),
        member({ id: 'self-made', email: 'self@example.com', name: 'Never Invited', hasLoggedIn: false, invitedBy: null }),
      ]
      mockApi(rows)
      renderMembers()
      for (const [name, expected] of [
        ['Jane Pending', true],
        ['Signed In', false],
        ['Gone Pending', false],
        ['Never Invited', false],
      ] as const) {
        const menu = await openMenuFor(name)
        const labels = within(menu).getAllByRole('menuitem').map(b => b.textContent)
        expect(labels.includes('Change email…')).toBe(expected)
        expect(labels.includes('Resend invite')).toBe(expected)
        fireEvent.keyDown(menu, { key: 'Escape' })
      }
    })

    it('never appears on your own row', async () => {
      mockApi([OWNER])
      renderMembers()
      await screen.findByText(OWNER.email)
      expect(screen.queryByRole('button', { name: '···' })).not.toBeInTheDocument()
    })

    it('is not offered to an Admin on a pending Owner', async () => {
      authState.user = { id: 'admin-1', email: 'admin@example.com', name: 'An Admin', role: 'admin' }
      const pendingOwner = member({ id: 'po-1', email: 'boss@exmaple.com', name: 'Pending Owner', role: 'owner', hasLoggedIn: false })
      mockApi([OWNER, member({ id: 'admin-1', email: 'admin@example.com', name: 'An Admin', role: 'admin' }), pendingOwner, PENDING])
      renderMembers()
      const ownerMenu = await openMenuFor('Pending Owner')
      expect(within(ownerMenu).queryByRole('menuitem', { name: 'Change email…' })).not.toBeInTheDocument()
      fireEvent.keyDown(ownerMenu, { key: 'Escape' })
      const menu = await openMenuFor('Jane Pending')
      expect(within(menu).getByRole('menuitem', { name: 'Change email…' })).toBeInTheDocument()
    })

    it('is disabled in demo mode', async () => {
      demoState.demoLocked = true
      mockApi()
      renderMembers()
      const menu = await openMenuFor('Jane Pending')
      expect(within(menu).getByRole('menuitem', { name: 'Change email…' })).toBeDisabled()
    })
  })

  describe('the dialog', () => {
    it('is pre-filled with the current address, focused, and explains what saving does', async () => {
      mockApi()
      renderMembers()
      const dialog = await openDialog()
      const input = within(dialog).getByLabelText('Email address') as HTMLInputElement
      expect(input.value).toBe('jane@exmaple.com')
      await waitFor(() => expect(input).toHaveFocus())
      expect(input).toHaveAttribute('aria-required', 'true')
      expect(within(dialog).getByText('The old invite link will stop working, and a new invite goes to this address.')).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Send new invite' })).toBeInTheDocument()
    })

    it('closes on Escape without sending anything', async () => {
      const spy = mockApi()
      renderMembers()
      const dialog = await openDialog()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(changeEmailCalls(spy)).toHaveLength(0)
    })

    it('gates a blank address with the standard required message and sends nothing', async () => {
      const spy = mockApi()
      renderMembers()
      const dialog = await openDialog()
      fireEvent.change(within(dialog).getByLabelText('Email address'), { target: { value: '   ' } })
      const send = within(dialog).getByRole('button', { name: 'Send new invite' })
      expect(send).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(send)
      expect(within(dialog).getByText(REQUIRED_MESSAGE)).toBeVisible()
      expect(changeEmailCalls(spy)).toHaveLength(0)
    })
  })

  describe('client-side checks', () => {
    async function expectInlineError(dialog: HTMLElement, message: string, typed: string) {
      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(alert).toHaveStyle({ color: color.textErrorRed })
      const input = within(dialog).getByLabelText('Email address') as HTMLInputElement
      // An email input drops surrounding spaces from its value, as browsers do.
      expect(input.value).toBe(typed.trim())
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('dialog', { name: 'Change email' })).toBeInTheDocument()
    }

    it.each(['not-an-email', 'jane@example', 'jane @example.com'])('refuses a malformed address (%s) without a request', async (typed) => {
      const spy = mockApi()
      renderMembers()
      const dialog = await openDialog()
      fireEvent.change(within(dialog).getByLabelText('Email address'), { target: { value: typed } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send new invite' }))
      await expectInlineError(dialog, INVALID, typed)
      expect(changeEmailCalls(spy)).toHaveLength(0)
    })

    it.each(['jane@exmaple.com', '  JANE@Exmaple.com  ', 'jane@exmaple.com;'])('refuses an unchanged address (%s) and points to Resend invite, without a request', async (typed) => {
      const spy = mockApi()
      renderMembers()
      const dialog = await openDialog()
      fireEvent.change(within(dialog).getByLabelText('Email address'), { target: { value: typed } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send new invite' }))
      await expectInlineError(dialog, UNCHANGED, typed)
      expect(changeEmailCalls(spy)).toHaveLength(0)
    })

    it('clears the error once the address is edited', async () => {
      mockApi()
      renderMembers()
      const dialog = await openDialog()
      const input = within(dialog).getByLabelText('Email address')
      fireEvent.change(input, { target: { value: 'nope' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send new invite' }))
      await within(dialog).findByRole('alert')
      fireEvent.change(input, { target: { value: 'nope@' } })
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
    })
  })

  describe('server responses', () => {
    it.each([
      [new ApiError(409, IN_USE), IN_USE],
      [new ApiError(400, SUPPRESSED), SUPPRESSED],
      [new ApiError(400, UNCHANGED), UNCHANGED],
      [new ApiError(400, INVALID), INVALID],
      [new TypeError('network down'), "Couldn't change the address. Try again."],
    ])('shows "%s" in red inside the dialog, keeping the typed value', async (err, message) => {
      mockApi(undefined, { '/admin/members/pending-1/change-email': () => { throw err } })
      renderMembers()
      const dialog = await openDialog()
      const input = within(dialog).getByLabelText('Email address') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'Jane@Example.com' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send new invite' }))
      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(alert).toHaveStyle({ color: color.textErrorRed })
      expect(input.value).toBe('Jane@Example.com')
      expect(input).not.toBeDisabled()
      expect(screen.getByRole('dialog', { name: 'Change email' })).toBeInTheDocument()
      // The row still shows the old address.
      expect(screen.getByText('jane@exmaple.com')).toBeInTheDocument()
    })

    it('sends the cleaned, lowercased address, then closes, updates the row, and confirms with a toast', async () => {
      const spy = mockApi(undefined, {
        '/admin/members/pending-1/change-email': () => ({ ok: true, email: 'jane@example.com' }),
      })
      renderMembers()
      const dialog = await openDialog()
      fireEvent.change(within(dialog).getByLabelText('Email address'), { target: { value: ' Jane@Example.com; ' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send new invite' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      const [[path, init]] = changeEmailCalls(spy)
      expect(path).toBe('/admin/members/pending-1/change-email')
      expect(init).toMatchObject({ method: 'POST' })
      expect(JSON.parse(String(init!.body))).toEqual({ email: 'jane@example.com' })

      expect(await screen.findByText('New invite sent to jane@example.com.')).toBeInTheDocument()
      const row = screen.getByText('Jane Pending').closest('tr')!
      expect(within(row).getByText('jane@example.com')).toBeInTheDocument()
      expect(screen.queryByText('jane@exmaple.com')).not.toBeInTheDocument()
      // Still a pending invite.
      expect(within(row).getByText('Invite pending')).toBeInTheDocument()
      // Focus goes back to the row's actions button.
      expect(within(row).getByRole('button', { name: '···' })).toHaveFocus()
    })

    it('submits on Enter in the field', async () => {
      const spy = mockApi(undefined, {
        '/admin/members/pending-1/change-email': () => ({ ok: true, email: 'jane@example.com' }),
      })
      renderMembers()
      const dialog = await openDialog()
      const input = within(dialog).getByLabelText('Email address')
      fireEvent.change(input, { target: { value: 'jane@example.com' } })
      fireEvent.submit(input.closest('form')!)
      await waitFor(() => expect(changeEmailCalls(spy)).toHaveLength(1))
    })
  })

  it('labels the change in Login activity', async () => {
    mockApi(undefined, {
      '/admin/members/pending-1/auth-events': () => ({
        events: [{
          id: 'e1', event: 'email_changed', reason: 'jane@exmaple.com', email: 'jane@example.com', actorName: 'Sole Owner',
          linkType: null, provider: null, ipCountry: null, createdAt: new Date().toISOString(),
        }],
        suppression: { suppressed: false },
        delivery: {},
      }),
    })
    renderMembers()
    const menu = await openMenuFor('Jane Pending')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Login activity' }))
    expect(await screen.findByText('Email changed from jane@exmaple.com to jane@example.com by Sole Owner')).toBeInTheDocument()
  })
})
