import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
}))

import { apiFetch } from '../lib/api'
const mockFetch = vi.mocked(apiFetch)

import { AuthProvider } from './AuthContext'
import { FeedUnreadProvider, useFeedUnread } from './FeedUnreadContext'

// user.lastSeenFeed is BEFORE the latest event, so something is genuinely unread.
const USER = {
  id: 'u1', email: 'a@b.com', name: 'A', role: 'member',
  subtitle: null, canVote: true, emailDigestEnabled: true,
  lastSeenFeed: '2020-01-01 00:00:00',
}
const LATEST_EVENT_AT = '2020-06-01 00:00:00' // newer than lastSeenFeed

beforeEach(() => {
  vi.resetAllMocks()
  mockFetch.mockImplementation(async (path: string) => {
    if (path === '/auth/me') return { ...USER }
    if (path.startsWith('/feed?')) return { latestEventAt: LATEST_EVENT_AT, lastSeenFeed: USER.lastSeenFeed, events: [], total: 0 }
    if (path === '/feed/seen') return null
    throw new Error('unexpected path: ' + path)
  })
})

function Probe() {
  const { hasUnread, visitHadUnread, initialized, markSeen, endVisit } = useFeedUnread()
  return (
    <div>
      <span data-testid="initialized">{String(initialized)}</span>
      <span data-testid="hasUnread">{String(hasUnread)}</span>
      <span data-testid="visitHadUnread">{String(visitHadUnread)}</span>
      <button onClick={() => { void markSeen() }}>seen</button>
      <button onClick={() => endVisit()}>endVisit</button>
    </div>
  )
}

// AuthProvider stays mounted (it lives above the router in App.tsx); the keyed
// FeedUnreadProvider remounts, mimicking a fresh page load / new window/tab.
// (Note: in-app route changes do NOT remount the provider — AppLayout is reused;
// the lingering dot is cleared on navigation by Feed calling endVisit() instead.)
function Harness({ providerKey }: { providerKey: number }) {
  return (
    <AuthProvider>
      <FeedUnreadProvider key={providerKey}>
        <Probe />
      </FeedUnreadProvider>
    </AuthProvider>
  )
}

// The real architecture: FeedUnreadProvider stays mounted across navigation
// (AppLayout is reused, not remounted). The Feed page unmounts on
// navigation and calls endVisit() in its cleanup. This harness mirrors that —
// the provider never gets a new key.
function StableHarness() {
  return (
    <AuthProvider>
      <FeedUnreadProvider>
        <Probe />
      </FeedUnreadProvider>
    </AuthProvider>
  )
}

describe('FeedUnreadContext — endVisit clears the lingering dot', () => {
  it('clears visitHadUnread when the visit ends, without a remount', async () => {
    render(<StableHarness />)
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))

    // Visit Feed: markSeen advances the baseline; the dot lingers for the visit.
    await userEvent.click(screen.getByText('seen'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('false'))
    expect(screen.getByTestId('visitHadUnread').textContent).toBe('true')

    // Navigate away: Feed unmounts and ends the visit. Provider stays mounted.
    await userEvent.click(screen.getByText('endVisit'))

    await waitFor(() => expect(screen.getByTestId('visitHadUnread').textContent).toBe('false'))
    expect(screen.getByTestId('hasUnread').textContent).toBe('false')
  })
})

describe('FeedUnreadContext — visitHadUnread', () => {
  it('is false before markSeen is called', async () => {
    render(<Harness providerKey={1} />)
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))
    // Poll confirmed unreads, but markSeen hasn't fired yet
    expect(screen.getByTestId('visitHadUnread').textContent).toBe('false')
  })

  it('becomes true after markSeen when there were unreads, and stays true', async () => {
    render(<Harness providerKey={1} />)
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))

    await userEvent.click(screen.getByText('seen'))

    // hasUnread goes false (baseline advanced past the event), but visitHadUnread stays true
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('false'))
    expect(screen.getByTestId('visitHadUnread').textContent).toBe('true')
  })

  it('resets to false on a fresh mount (new window / page reload)', async () => {
    const { rerender } = render(<Harness providerKey={1} />)
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))
    await userEvent.click(screen.getByText('seen'))
    await waitFor(() => expect(screen.getByTestId('visitHadUnread').textContent).toBe('true'))

    // Fresh page load / new window: the provider mounts anew (new key)
    await act(async () => { rerender(<Harness providerKey={2} />) })
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))

    // visitHadUnread is gone — no unreads survive into the new visit
    expect(screen.getByTestId('visitHadUnread').textContent).toBe('false')
    expect(screen.getByTestId('hasUnread').textContent).toBe('false')
  })

  it('stays false after markSeen when there were no unreads', async () => {
    // Latest event is OLDER than lastSeenFeed — nothing is unread
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { ...USER }
      if (path.startsWith('/feed?')) return { latestEventAt: '2019-01-01 00:00:00', lastSeenFeed: USER.lastSeenFeed, events: [], total: 0 }
      if (path === '/feed/seen') return null
      throw new Error('unexpected path: ' + path)
    })

    render(<Harness providerKey={1} />)
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('false'))

    await userEvent.click(screen.getByText('seen'))

    expect(screen.getByTestId('visitHadUnread').textContent).toBe('false')
  })
})

describe('FeedUnreadContext — dot survives a fresh mount (new window / reload)', () => {
  it('does not relight the unread dot after marking seen and remounting', async () => {
    const { rerender } = render(<Harness providerKey={1} />)

    // Seeded from user; latest event is newer than lastSeenFeed → dot on.
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))

    // Visit Feed → markSeen clears the dot.
    await userEvent.click(screen.getByText('seen'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('false'))

    // Navigate away and back: AppLayout (and FeedUnreadProvider) remount.
    await act(async () => { rerender(<Harness providerKey={2} />) })

    // After remount the dot must stay cleared — there is nothing new.
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('false'))
  })

  it('still lights the dot for genuinely new activity after marking seen and remounting', async () => {
    // Latest event is in the future relative to "now", i.e. newer than any
    // baseline markSeen could set — this stands in for real unseen activity.
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { ...USER }
      if (path.startsWith('/feed?')) return { latestEventAt: '2099-01-01 00:00:00', lastSeenFeed: USER.lastSeenFeed, events: [], total: 0 }
      if (path === '/feed/seen') return null
      throw new Error('unexpected path: ' + path)
    })

    const { rerender } = render(<Harness providerKey={1} />)
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))

    // Even after marking seen, the future-dated event keeps the dot lit — the
    // fix advances the baseline to "now", which is still older than the event.
    await userEvent.click(screen.getByText('seen'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))

    // And the dot survives a navigation remount, because the activity is real.
    await act(async () => { rerender(<Harness providerKey={2} />) })
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))
  })
})

describe('FeedUnreadContext — cross-window seen baseline', () => {
  it('clears the dot when the poll reports a newer seen baseline (read in another window)', async () => {
    // Seed is older than the event (dot would light), but the server's lastSeenFeed
    // is newer than the event — i.e. another window already read Feed. The poll
    // must adopt that baseline and clear the dot without a local markSeen here.
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { ...USER }
      if (path.startsWith('/feed?')) return { latestEventAt: LATEST_EVENT_AT, lastSeenFeed: '2020-07-01 00:00:00', events: [], total: 0 }
      if (path === '/feed/seen') return null
      throw new Error('unexpected path: ' + path)
    })

    render(<Harness providerKey={1} />)
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('false'))
  })

  it('does not regress the baseline when the poll reports an older seen value', async () => {
    // Seed (2020-01-01) is newer than the server value the poll returns (2019).
    // The forward-only guard must ignore it, leaving the genuine unread lit.
    mockFetch.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return { ...USER }
      if (path.startsWith('/feed?')) return { latestEventAt: LATEST_EVENT_AT, lastSeenFeed: '2019-01-01 00:00:00', events: [], total: 0 }
      if (path === '/feed/seen') return null
      throw new Error('unexpected path: ' + path)
    })

    render(<Harness providerKey={1} />)
    await waitFor(() => expect(screen.getByTestId('initialized').textContent).toBe('true'))
    await waitFor(() => expect(screen.getByTestId('hasUnread').textContent).toBe('true'))
  })
})
