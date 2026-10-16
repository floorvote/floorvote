import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import * as api from '../lib/api'
import { ApiError } from '../lib/api'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

const demo = vi.hoisted(() => ({ demoLocked: false }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'jane@oldjob.org', name: 'Jane', role: 'member', title: null,
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
// The real widget loads Cloudflare's script. This one hands over a token on click.
vi.mock('../components/Turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (t: string | null) => void }) =>
    <button type="button" onClick={() => onToken('solved-token')}>Solve challenge</button>,
}))

import { Profile } from './Profile'

function renderProfile() {
  const value = { config: { orgNoun: 'team' } as AppConfig, multiState: false, loading: false }
  return render(
    <ConfigContext.Provider value={value}>
      <MemoryRouter><Profile /></MemoryRouter>
    </ConfigContext.Provider>,
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

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change email…' }))
  return screen.findByLabelText('New email')
}

describe('Profile: change your email', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    demo.demoLocked = false
  })

  it('requests the change and says where the confirmation went, leaving the address as it is', async () => {
    const spy = mockApi({ '/users/me/email-change': () => ({ ok: true, email: 'jane@newjob.org' }) })
    renderProfile()
    fireEvent.change(await openForm(), { target: { value: 'Jane@NewJob.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }))

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('We sent a confirmation link to jane@newjob.org.')
    expect(notice).toHaveTextContent('Your email stays jane@oldjob.org until you open that link and confirm. It expires in 24 hours.')
    expect(requests(spy)).toEqual([{ email: 'Jane@NewJob.org', turnstileToken: null }])
    expect(screen.queryByLabelText('New email')).not.toBeInTheDocument()
    expect(screen.getByText('jane@oldjob.org')).toBeInTheDocument()
  })

  it("shows the server's reason when the request is refused, and keeps the form open", async () => {
    mockApi({
      '/users/me/email-change': () => { throw new ApiError(409, 'That address is already used by another member.') },
    })
    renderProfile()
    fireEvent.change(await openForm(), { target: { value: 'bob@shared.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That address is already used by another member.')
    expect(screen.getByLabelText('New email')).toHaveValue('bob@shared.org')
  })

  it('waits for Turnstile when it is configured, and sends its token', async () => {
    const spy = mockApi({ '/users/me/email-change': () => ({ ok: true, email: 'jane@newjob.org' }) }, 'site-key')
    renderProfile()
    fireEvent.change(await openForm(), { target: { value: 'jane@newjob.org' } })
    const send = screen.getByRole('button', { name: 'Send confirmation' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Solve challenge' })).toBeInTheDocument())
    expect(send).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Solve challenge' }))
    expect(send).toBeEnabled()
    fireEvent.click(send)
    await screen.findByRole('status')
    expect(requests(spy)).toEqual([{ email: 'jane@newjob.org', turnstileToken: 'solved-token' }])
  })

  it('cancelling closes the form without a request', async () => {
    const spy = mockApi()
    renderProfile()
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('New email')).not.toBeInTheDocument()
    expect(requests(spy)).toHaveLength(0)
  })

  it('is locked on a demo instance', async () => {
    demo.demoLocked = true
    mockApi()
    renderProfile()
    expect(await screen.findByRole('button', { name: 'Change email…' })).toBeDisabled()
  })

  it('shows the steps of a change in account history, in plain words', async () => {
    mockApi({
      '/users/me/auth-events': () => ({
        events: [
          { id: 'e2', event: 'email_change_confirmed', email: 'jane@newjob.org', reason: 'jane@oldjob.org', actorId: 'u1', actorName: 'Jane', linkType: null, provider: null, ipCountry: null, createdAt: '2026-10-12 10:05:00' },
          { id: 'e1', event: 'email_change_requested', email: 'jane@newjob.org', reason: 'jane@oldjob.org', actorId: 'u1', actorName: 'Jane', linkType: null, provider: null, ipCountry: null, createdAt: '2026-10-12 10:00:00' },
        ],
      }),
    })
    renderProfile()
    fireEvent.click(await screen.findByRole('button', { name: 'Show my login activity' }))
    const history = (await screen.findByText('You changed your email from jane@oldjob.org to jane@newjob.org')).closest('div')!.parentElement!.parentElement!
    expect(within(history).getByText('You asked to change your email to jane@newjob.org')).toBeInTheDocument()
  })
})
