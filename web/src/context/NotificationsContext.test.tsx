import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { NotificationsProvider, useNotifications } from './NotificationsContext'

const demoState = vi.hoisted(() => ({ demoMode: false, demoLocked: false, settled: true }))
vi.mock('./DemoContext', () => ({
  useDemo: () => ({ ...demoState }),
}))

// Two mentions, both unread on the server, plus one the server already calls
// read. The server's own unreadCount is deliberately the server's answer, not
// the answer the demo should show — that difference is the whole test.
const payload = vi.hoisted(() => ({
  unreadCount: 2,
  mentions: [
    { id: 'm1', isUnread: true },
    { id: 'm2', isUnread: true },
    { id: 'm3', isUnread: false },
  ],
}))

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async () => payload),
}))

function Consumer() {
  const { unreadCount, loaded } = useNotifications()
  return <div>{loaded ? `count:${unreadCount}` : 'pending'}</div>
}

function renderProvider() {
  return render(
    <NotificationsProvider>
      <Consumer />
    </NotificationsProvider>,
  )
}

describe('NotificationsProvider badge count', () => {
  afterEach(() => {
    demoState.demoMode = false
    localStorage.clear()
  })

  it('uses the server unreadCount verbatim on a non-demo tenant', async () => {
    localStorage.setItem('floorvote:demo:readMentions', JSON.stringify(['m1']))
    renderProvider()
    // The local set exists but must be ignored: on a real tenant read_at is
    // authoritative and per-user.
    await waitFor(() => expect(screen.getByText('count:2')).toBeInTheDocument())
  })

  it('subtracts this browser’s locally-read mentions on a demo tenant', async () => {
    demoState.demoMode = true
    localStorage.setItem('floorvote:demo:readMentions', JSON.stringify(['m1']))
    renderProvider()
    // m1 read locally, m2 unread, m3 already read on the server.
    await waitFor(() => expect(screen.getByText('count:1')).toBeInTheDocument())
  })

  // The badge and the panel's blue rails must apply the same rule. The panel
  // ANDs the server's isUnread with the absence of a local record; the badge
  // used to ignore isUnread entirely, so a server-read mention this browser had
  // no local record of lit the bell while every row rendered as read.
  it('does not count a mention the server already calls read', async () => {
    demoState.demoMode = true
    renderProvider()
    // Nothing in localStorage: m1 and m2 are unread, m3 is not.
    await waitFor(() => expect(screen.getByText('count:2')).toBeInTheDocument())
  })
})
