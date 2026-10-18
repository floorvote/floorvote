import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'

function member(overrides: Record<string, unknown>) {
  return {
    email: 'x@example.com', name: 'Someone', role: 'member' as const, title: null,
    createdAt: '2024-01-01T00:00:00Z', lastActive: '2024-01-01T00:00:00Z', deactivatedAt: null,
    hasLoggedIn: true, invitedBy: { id: 'owner-1', name: 'Sole Owner', email: 'owner@example.com' },
    roles: [], canVote: true, voteCount: 0, ...overrides,
  }
}
const OWNER = member({ id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner', invitedBy: null })
const PENDING = member({ id: 'pending-1', email: 'jane@exmaple.com', name: 'Jane Pending', hasLoggedIn: false })
const ACTIVE = member({ id: 'in-1', email: 'sam@oldjob.org', name: 'Sam Signed In' })
const OTHER = member({ id: 'in-2', email: 'pat@elsewhere.org', name: 'Pat Other' })

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' }, loading: false }),
}))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

type Handler = (init?: RequestInit) => unknown
function mockApi(handlers: Record<string, Handler> = {}) {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/members') return [OWNER, PENDING, ACTIVE, OTHER] as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    const handler = handlers[path]
    if (handler) return handler(init) as never
    return {} as never
  })
}
const calls = (spy: ReturnType<typeof mockApi>, id: string) =>
  spy.mock.calls.filter(c => c[0] === `/admin/members/${id}/change-email`).map(c => JSON.parse(String(c[1]?.body)))

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr')!
async function openDialogFor(name: string) {
  const row = await rowOf(name)
  fireEvent.click(within(row).getByRole('button', { name: '···' }))
  fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Change email…' }))
  return screen.findByRole('dialog', { name: 'Change email' })
}
async function sendFor(name: string, address: string, button: string) {
  const dialog = await openDialogFor(name)
  fireEvent.change(within(dialog).getByLabelText('Email address'), { target: { value: address } })
  fireEvent.click(within(dialog).getByRole('button', { name: button }))
}

const ACTIVE_OK = { '/admin/members/in-1/change-email': () => ({ ok: true, email: 'sam@newjob.org', pending: true }) }

describe('Members row: email change states', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  describe('active member, sent and pending', () => {
    it('shows the short pill in the member row, with Resend and Cancel, while the old address stays', async () => {
      mockApi(ACTIVE_OK)
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const row = await rowOf('Sam Signed In')
      expect(await within(row).findByText('→ sam@newjob.org · Link sent')).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'Resend' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(within(row).getByText('sam@oldjob.org')).toBeInTheDocument()
    })

    it('announces the result to a screen reader', async () => {
      mockApi(ACTIVE_OK)
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const row = await rowOf('Sam Signed In')
      const status = await within(row).findByRole('status')
      expect(status).toHaveTextContent('Link sent to sam@newjob.org. The address changes once they confirm it.')
    })

    it('leaves other members rows without a pill', async () => {
      mockApi(ACTIVE_OK)
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      await screen.findByText('→ sam@newjob.org · Link sent')
      const other = await rowOf('Pat Other')
      expect(within(other).queryByText(/Link sent/)).not.toBeInTheDocument()
      expect(within(other).queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
    })

    it('puts focus back on the row actions button after the dialog saves', async () => {
      mockApi(ACTIVE_OK)
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const row = await rowOf('Sam Signed In')
      await waitFor(() => expect(within(row).getByRole('button', { name: '···' })).toHaveFocus())
    })

    it('Resend posts the same address and announces it again', async () => {
      const spy = mockApi(ACTIVE_OK)
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const row = await rowOf('Sam Signed In')
      fireEvent.click(await within(row).findByRole('button', { name: 'Resend' }))
      await waitFor(() => expect(calls(spy, 'in-1')).toHaveLength(2))
      expect(calls(spy, 'in-1')[1]).toEqual({ email: 'sam@newjob.org' })
      await waitFor(() => expect(within(row).getByRole('status')).toHaveTextContent('Link sent again to sam@newjob.org.'))
    })

    it('a refused Resend keeps the pill and shows the server message in the row', async () => {
      let n = 0
      mockApi({
        '/admin/members/in-1/change-email': () => {
          n++
          if (n > 1) throw new ApiError(429, "A change to this member's email was requested three times in the past day. Please try again tomorrow.")
          return { ok: true, email: 'sam@newjob.org', pending: true }
        },
      })
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const row = await rowOf('Sam Signed In')
      fireEvent.click(await within(row).findByRole('button', { name: 'Resend' }))
      expect(await within(row).findByRole('alert')).toHaveTextContent('requested three times in the past day')
      expect(within(row).getByText('→ sam@newjob.org · Link sent')).toBeInTheDocument()
      await waitFor(() => expect(within(row).getByRole('button', { name: 'Resend' })).toHaveFocus())
    })

    it('Cancel removes the pill, leaves the address, sends nothing, and focuses the row actions button', async () => {
      const spy = mockApi(ACTIVE_OK)
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const row = await rowOf('Sam Signed In')
      fireEvent.click(await within(row).findByRole('button', { name: 'Cancel' }))
      expect(within(row).queryByText(/Link sent/)).not.toBeInTheDocument()
      expect(within(row).getByText('sam@oldjob.org')).toBeInTheDocument()
      await waitFor(() => expect(within(row).getByRole('button', { name: '···' })).toHaveFocus())
      expect(calls(spy, 'in-1')).toHaveLength(1)
    })

    it('Escape on the pill cancels it', async () => {
      mockApi(ACTIVE_OK)
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const row = await rowOf('Sam Signed In')
      fireEvent.keyDown(await within(row).findByRole('button', { name: 'Resend' }), { key: 'Escape' })
      expect(within(row).queryByText(/Link sent/)).not.toBeInTheDocument()
    })
  })

  describe('pending invite, confirmed on the spot', () => {
    it('shows "✓ Changed today" in the row, with the new address, and announces it', async () => {
      mockApi({ '/admin/members/pending-1/change-email': () => ({ ok: true, email: 'jane@example.com' }) })
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Jane Pending', 'jane@example.com', 'Send new invite')
      const row = await rowOf('Jane Pending')
      expect(await within(row).findByText('✓ Changed today')).toBeInTheDocument()
      expect(within(row).getByText('jane@example.com')).toBeInTheDocument()
      expect(within(row).queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
      expect(within(row).getByRole('status')).toHaveTextContent('Invite address changed to jane@example.com, and a new invite was sent.')
      await waitFor(() => expect(within(row).getByRole('button', { name: '···' })).toHaveFocus())
    })
  })

  describe('editing and refusals in the dialog', () => {
    it('Escape cancels the edit, sends nothing, and focus returns to the row actions button', async () => {
      const spy = mockApi()
      render(<MemoryRouter><Members /></MemoryRouter>)
      const dialog = await openDialogFor('Sam Signed In')
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      const row = await rowOf('Sam Signed In')
      await waitFor(() => expect(within(row).getByRole('button', { name: '···' })).toHaveFocus())
      expect(calls(spy, 'in-1')).toHaveLength(0)
      expect(within(row).queryByText(/Link sent/)).not.toBeInTheDocument()
    })

    it.each([
      [new ApiError(409, 'Another member already uses that address.'), 'Another member already uses that address.'],
      [new ApiError(400, "This address can't receive email. Check it for a typo."), "This address can't receive email. Check it for a typo."],
    ])('keeps the refusal "%s" in the dialog, refocuses the input, announces it, and adds no pill', async (err, message) => {
      mockApi({ '/admin/members/in-1/change-email': () => { throw err } })
      render(<MemoryRouter><Members /></MemoryRouter>)
      await sendFor('Sam Signed In', 'sam@newjob.org', 'Send confirmation')
      const dialog = screen.getByRole('dialog', { name: 'Change email' })
      const alert = await within(dialog).findByRole('alert')
      expect(alert).toHaveTextContent(message)
      const input = within(dialog).getByLabelText('Email address')
      expect(input.getAttribute('aria-describedby')).toBe(alert.id)
      await waitFor(() => expect(input).toHaveFocus())
      const row = await rowOf('Sam Signed In')
      expect(within(row).queryByText(/Link sent/)).not.toBeInTheDocument()
    })
  })
})
