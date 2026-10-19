import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../lib/api'
import { ApiError } from '../lib/api'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

const auth = vi.hoisted(() => ({ email: 'jane@oldjob.org' }))
const demo = vi.hoisted(() => ({ demoLocked: false }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: auth.email, name: 'Jane', role: 'member', title: null,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
      isLastOwner: false,
    },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demo.demoLocked, demoLocked: demo.demoLocked, settled: true }),
}))
vi.mock('../components/Turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (t: string | null) => void }) =>
    <button type="button" onClick={() => onToken('solved-token')}>Solve challenge</button>,
}))

import { Profile } from './Profile'

function tree() {
  const value = { config: { orgNoun: 'team' } as AppConfig, multiState: false, loading: false }
  return (
    <ConfigContext.Provider value={value}>
      <MemoryRouter><Profile /></MemoryRouter>
    </ConfigContext.Provider>
  )
}

type Handler = (init?: RequestInit) => unknown
function mockApi(handlers: Record<string, Handler> = {}, siteKey = '') {
  return vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/config') return {} as never
    if (path === '/auth/demo-mode') return { demoMode: false, turnstileSiteKey: siteKey } as never
    const handler = handlers[path]
    if (handler) return handler(init) as never
    return {} as never
  })
}
const requests = (spy: ReturnType<typeof mockApi>) =>
  spy.mock.calls.filter(c => c[0] === '/users/me/email-change').map(c => JSON.parse(String(c[1]?.body)))

const OK = { '/users/me/email-change': () => ({ ok: true, email: 'jane@newjob.org' }) }

async function openEdit() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change email…' }))
  return screen.findByLabelText('New email') as Promise<HTMLInputElement>
}
async function sendTo(address: string) {
  const input = await openEdit()
  fireEvent.change(input, { target: { value: address } })
  fireEvent.click(screen.getByRole('button', { name: 'Send link' }))
  return input
}

describe('Profile email row: inline change', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    demo.demoLocked = false
    auth.email = 'jane@oldjob.org'
  })

  describe('editing', () => {
    it('opens the input in the email row itself, focused, not in a separate form below', async () => {
      mockApi()
      render(tree())
      const input = await openEdit()
      await waitFor(() => expect(input).toHaveFocus())
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      const row = screen.getByTestId('email-row')
      expect(within(row).getByLabelText('New email')).toBe(input)
      expect(within(row).getByText('jane@oldjob.org')).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'Send link' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(within(row).queryByRole('button', { name: 'Change email…' })).not.toBeInTheDocument()
    })

    it('sends on Enter in the field', async () => {
      const spy = mockApi(OK)
      render(tree())
      const input = await openEdit()
      fireEvent.change(input, { target: { value: 'jane@newjob.org' } })
      fireEvent.submit(input.closest('form')!)
      await screen.findByText('→ jane@newjob.org · Link sent')
      expect(requests(spy)).toEqual([{ email: 'jane@newjob.org' }])
    })

    it('cancels with Escape, sends nothing, and puts focus back on the row button', async () => {
      const spy = mockApi()
      render(tree())
      const input = await openEdit()
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByLabelText('New email')).not.toBeInTheDocument()
      const back = screen.getByRole('button', { name: 'Change email…' })
      await waitFor(() => expect(back).toHaveFocus())
      expect(requests(spy)).toHaveLength(0)
      expect(screen.getByText('jane@oldjob.org')).toBeInTheDocument()
    })

    it('cancels with the Cancel button and puts focus back on the row button', async () => {
      mockApi()
      render(tree())
      await openEdit()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Change email…' })).toHaveFocus())
    })

    it('starts empty each time it is opened', async () => {
      mockApi()
      render(tree())
      fireEvent.change(await openEdit(), { target: { value: 'half@typed.org' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(await openEdit()).toHaveValue('')
    })

    it('keeps Send disabled until there is an address', async () => {
      mockApi()
      render(tree())
      await openEdit()
      expect(screen.getByRole('button', { name: 'Send link' })).toBeDisabled()
    })
  })

  describe('sent and pending', () => {
    it('shows the short pill with Resend and Cancel, keeps the current address, and announces the full message', async () => {
      mockApi(OK)
      render(tree())
      await sendTo('jane@newjob.org')
      expect(await screen.findByText('→ jane@newjob.org · Link sent')).toBeInTheDocument()
      const row = screen.getByTestId('email-row')
      expect(within(row).getByRole('button', { name: 'Resend' })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(within(row).queryByLabelText('New email')).not.toBeInTheDocument()
      expect(within(row).getByText('jane@oldjob.org')).toBeInTheDocument()
      const status = screen.getByRole('status')
      expect(status).toHaveTextContent('Link sent to jane@newjob.org.')
      expect(status).toHaveTextContent('Your email stays jane@oldjob.org until you confirm it. The link expires in 24 hours.')
    })

    it('moves focus to Resend once the link is sent', async () => {
      mockApi(OK)
      render(tree())
      await sendTo('jane@newjob.org')
      await waitFor(() => expect(screen.getByRole('button', { name: 'Resend' })).toHaveFocus())
    })

    it('Resend posts the same address again and announces it', async () => {
      const spy = mockApi(OK)
      render(tree())
      await sendTo('Jane@NewJob.org')
      fireEvent.click(await screen.findByRole('button', { name: 'Resend' }))
      await waitFor(() => expect(requests(spy)).toHaveLength(2))
      expect(requests(spy)[1]).toEqual({ email: 'jane@newjob.org' })
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link sent again to jane@newjob.org.'))
      expect(screen.getByText('→ jane@newjob.org · Link sent')).toBeInTheDocument()
    })

    it('a Resend that is refused stays in the pill with the message and keeps focus on Resend', async () => {
      let calls = 0
      mockApi({
        '/users/me/email-change': () => {
          calls++
          if (calls > 1) throw new ApiError(429, 'That address was sent several email-change confirmations in the past hour.')
          return { ok: true, email: 'jane@newjob.org' }
        },
      })
      render(tree())
      await sendTo('jane@newjob.org')
      fireEvent.click(await screen.findByRole('button', { name: 'Resend' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('That address was sent several email-change confirmations in the past hour.')
      expect(screen.getByText('→ jane@newjob.org · Link sent')).toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Resend' })).toHaveFocus())
    })

    it('Cancel from the pill leaves the current address, sends nothing more, and focuses the row button', async () => {
      const spy = mockApi(OK)
      render(tree())
      await sendTo('jane@newjob.org')
      await screen.findByText('→ jane@newjob.org · Link sent')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByText('→ jane@newjob.org · Link sent')).not.toBeInTheDocument()
      expect(screen.getByText('jane@oldjob.org')).toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Change email…' })).toHaveFocus())
      expect(requests(spy)).toHaveLength(1)
    })

    it('after Cancel, says plainly that a link already sent still works until it expires', async () => {
      mockApi(OK)
      render(tree())
      await sendTo('jane@newjob.org')
      await screen.findByText('→ jane@newjob.org · Link sent')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(await screen.findByText('Cancelled here. A link already sent still works until it expires.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Change email…' }))
      expect(screen.queryByText(/still works until it expires/)).not.toBeInTheDocument()
    })

    it('Escape on the pill cancels it', async () => {
      mockApi(OK)
      render(tree())
      await sendTo('jane@newjob.org')
      fireEvent.keyDown(await screen.findByRole('button', { name: 'Resend' }), { key: 'Escape' })
      expect(screen.queryByText('→ jane@newjob.org · Link sent')).not.toBeInTheDocument()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Change email…' })).toHaveFocus())
    })

    it('Resend is ready at once and shows no human check, even when Turnstile is configured', async () => {
      const spy = mockApi(OK, 'site-key')
      render(tree())
      fireEvent.change(await openEdit(), { target: { value: 'jane@newjob.org' } })
      expect(screen.queryByRole('button', { name: 'Solve challenge' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Send link' }))
      const resend = await screen.findByRole('button', { name: 'Resend' })
      expect(screen.queryByRole('button', { name: 'Solve challenge' })).not.toBeInTheDocument()
      expect(resend).toBeEnabled()
      fireEvent.click(resend)
      await waitFor(() => expect(requests(spy)).toHaveLength(2))
      expect(requests(spy)[1]).toEqual({ email: 'jane@newjob.org' })
    })
  })

  describe('confirmed', () => {
    it('shows "✓ Changed today" once the account address is the one the link went to', async () => {
      mockApi(OK)
      const view = render(tree())
      await sendTo('jane@newjob.org')
      await screen.findByText('→ jane@newjob.org · Link sent')
      auth.email = 'jane@newjob.org'
      view.rerender(tree())
      expect(await screen.findByText('✓ Changed today')).toBeInTheDocument()
      expect(screen.queryByText('→ jane@newjob.org · Link sent')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
      expect(screen.getByText('jane@newjob.org')).toBeInTheDocument()
    })
  })

  describe('refused', () => {
    it.each([
      [new ApiError(409, 'That address is already used by another member.'), 'That address is already used by another member.'],
      [new ApiError(400, 'Invalid email address'), 'Invalid email address'],
      [new ApiError(400, "That's already your address."), "That's already your address."],
      [new ApiError(429, 'Too many requests. Try again in a little while.'), 'Too many requests. Try again in a little while.'],
      [new ApiError(400, "This address can't receive email. Check it for a typo."), "This address can't receive email. Check it for a typo."],
      [new TypeError('network down'), 'Failed to send the confirmation. Please try again.'],
    ])('puts "%s" under the input, keeps the typed value, refocuses the input, and announces it', async (err, message) => {
      mockApi({ '/users/me/email-change': () => { throw err } })
      render(tree())
      const input = await sendTo('bob@shared.org')
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(message)
      expect(input).toHaveValue('bob@shared.org')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input.getAttribute('aria-describedby')).toBe(alert.id)
      await waitFor(() => expect(input).toHaveFocus())
      // The error sits under the input, inside the email row.
      expect(within(screen.getByTestId('email-row')).getByRole('alert')).toBe(alert)
      expect(screen.queryByText(/Link sent/)).not.toBeInTheDocument()
      expect(screen.getByText('jane@oldjob.org')).toBeInTheDocument()
    })

    it('clears the refusal when the address is edited', async () => {
      mockApi({ '/users/me/email-change': () => { throw new ApiError(409, 'Taken.') } })
      render(tree())
      const input = await sendTo('bob@shared.org')
      await screen.findByRole('alert')
      fireEvent.change(input, { target: { value: 'bob@other.org' } })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(input).not.toHaveAttribute('aria-invalid', 'true')
    })

    it('can try again after a refusal and reach the pending pill', async () => {
      let calls = 0
      mockApi({
        '/users/me/email-change': () => {
          calls++
          if (calls === 1) throw new ApiError(409, 'Taken.')
          return { ok: true, email: 'bob@other.org' }
        },
      })
      render(tree())
      const input = await sendTo('bob@shared.org')
      await screen.findByRole('alert')
      fireEvent.change(input, { target: { value: 'bob@other.org' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send link' }))
      expect(await screen.findByText('→ bob@other.org · Link sent')).toBeInTheDocument()
    })
  })

  it('stays locked on a demo instance', async () => {
    demo.demoLocked = true
    mockApi()
    render(tree())
    expect(await screen.findByRole('button', { name: 'Change email…' })).toBeDisabled()
  })
})
