import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// #449: the digest row names saved views once a member has included one, and lists
// them once, below the description, as chips that remove the subscription.

const auth = vi.hoisted(() => ({ user: {} as Record<string, unknown> }))
const demo = vi.hoisted(() => ({ demoLocked: false }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demo.demoLocked, demoLocked: demo.demoLocked, settled: true }),
}))

const DAILY = 'A daily summary of recent activity on priority bills.'
const WITH_VIEWS = 'A daily summary of recent activity on priority bills and bills in saved views.'

const views = [
  { id: 'v1', name: 'Transportation', query: 'state=RI', slug: 'transportation', previousSlug: null, subscribed: true },
  { id: 'v2', name: 'Elections', query: 'state=UT', slug: 'elections', previousSlug: null, subscribed: false },
  { id: 'v3', name: 'Courts', query: 'state=VT', slug: 'courts', previousSlug: null, subscribed: true },
]

function mock(over: { modules?: unknown; views?: unknown; putFails?: boolean } = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/config') return { modules: over.modules ?? { 'email-digest': { enabled: true } } } as never
    if (path === '/views') return { views: over.views ?? views } as never
    if (/^\/views\/.+\/subscription$/.test(path) && init?.method === 'PUT') {
      if (over.putFails) throw new Error('boom')
      return { subscribed: JSON.parse(init.body as string).subscribed } as never
    }
    return {} as never
  })
}

function signIn(over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role: 'member', title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

const digestRow = () => document.getElementById('setting-email-digest') as HTMLElement
const chips = () => within(digestRow()).queryByRole('list', { name: /saved views in your digest/i })

describe('Profile: saved views in the digest', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    demo.demoLocked = false
    signIn()
  })

  it('adds "and bills in saved views" to the description when a view is included', async () => {
    mock()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText(WITH_VIEWS)).toBeInTheDocument()
    expect(screen.queryByText(DAILY)).not.toBeInTheDocument()
  })

  it('leaves the description as it was when no view is included', async () => {
    mock({ views: views.map(v => ({ ...v, subscribed: false })) })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText(DAILY)).toBeInTheDocument()
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/views'))
    expect(screen.queryByText(WITH_VIEWS)).not.toBeInTheDocument()
    expect(chips()).not.toBeInTheDocument()
  })

  it('leaves the description as it was while the views have not loaded, and when they fail to', async () => {
    mock()
    const loaded = render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText(WITH_VIEWS)).toBeInTheDocument()
    loaded.unmount()
    vi.restoreAllMocks()
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/config') return { modules: { 'email-digest': { enabled: true } } } as never
      throw new Error('boom')
    })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(await screen.findByText(DAILY)).toBeInTheDocument()
    expect(chips()).not.toBeInTheDocument()
  })

  it('lists the included views once, in order, as chips beneath the description', async () => {
    mock()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WITH_VIEWS)
    const list = chips() as HTMLElement
    expect(within(list).getAllByRole('listitem').map(li => li.textContent?.replace('×', ''))).toEqual(['Transportation', 'Courts'])
    expect(digestRow()).toContainElement(list)
  })

  it('keeps the chips outside the digest switch\'s label, so a click on one cannot toggle the switch', async () => {
    mock()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WITH_VIEWS)
    expect((chips() as HTMLElement).closest('label')).toBeNull()
  })

  it('removes a view\'s subscription from its chip, and the chip and the wording follow', async () => {
    mock({ views: views.filter(v => v.id !== 'v3') })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WITH_VIEWS)

    await userEvent.click(screen.getByRole('button', { name: 'Remove Transportation from your digest' }))

    expect(api.apiFetch).toHaveBeenCalledWith('/views/v1/subscription', { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
    expect(await screen.findByText(DAILY)).toBeInTheDocument()
    expect(chips()).not.toBeInTheDocument()
  })

  it('keeps the other chips when one is removed', async () => {
    mock()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WITH_VIEWS)
    await userEvent.click(screen.getByRole('button', { name: 'Remove Transportation from your digest' }))
    await waitFor(() => expect(within(chips() as HTMLElement).getAllByRole('listitem').map(li => li.textContent?.replace('×', ''))).toEqual(['Courts']))
    expect(screen.getByText(WITH_VIEWS)).toBeInTheDocument()
  })

  it('puts a chip back when removing it fails', async () => {
    mock({ putFails: true })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WITH_VIEWS)
    await userEvent.click(screen.getByRole('button', { name: 'Remove Transportation from your digest' }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/views/v1/subscription', expect.anything()))
    expect(within(chips() as HTMLElement).getAllByRole('listitem')).toHaveLength(2)
  })

  it('cannot remove a chip on a locked demo tenant', async () => {
    demo.demoLocked = true
    mock()
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findByText(WITH_VIEWS)
    expect(screen.getByRole('button', { name: 'Remove Transportation from your digest' })).toBeDisabled()
  })

  it('shows no chips when the admin has turned the digest off', async () => {
    mock({ modules: { 'email-digest': { enabled: false } } })
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/views'))
    expect(await within(digestRow()).findByText(/turned off by your coalition/i)).toBeInTheDocument()
    expect(chips()).not.toBeInTheDocument()
  })
})
