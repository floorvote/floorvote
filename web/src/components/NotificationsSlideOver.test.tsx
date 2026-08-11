import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotificationsSlideOver } from './NotificationsSlideOver'
import { NotificationsProvider } from '../context/NotificationsContext'

// Mutable flag so individual tests can opt into demoLocked without a
// module-level mock rewrite per test (mirrors Members.roleRename.test.tsx).
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

// The @role-mention attribution chip ("mentioned @Board") previously showed
// its member list only in a hover-triggered tooltip (onMouseEnter/onMouseLeave)
// — mouse-only, so keyboard and touch users, and screen-reader users who never
// hover, had no way to see who's in the role. It must surface that list
// without depending on hover.
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/notifications' && (!init || init.method === undefined)) {
      return {
        unreadCount: 1,
        mentions: [
          {
            id: 'm1',
            commentId: 'c1',
            billId: 'b1',
            billNumber: 'SB123',
            billTitle: 'A test bill',
            billState: 'NJ',
            sessionSlug: 'session-1',
            authorName: 'Alice Author',
            authorSubtitle: null,
            commentPreview: 'preview',
            commentHtml: '<p>Please review.</p>',
            sourceType: 'role',
            sourceLabel: 'Board',
            createdAt: new Date().toISOString(),
            isUnread: false,
          },
        ],
      }
    }
    if (path === '/roles') {
      return [
        {
          id: 'r1',
          name: 'Board',
          members: [
            { id: 'u1', name: 'Alice Member', subtitle: null },
            { id: 'u2', name: 'Bob Member', subtitle: 'Treasurer' },
          ],
        },
      ]
    }
    if (path === '/notifications/mark-read') return {}
    return {}
  }),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

function renderPanel() {
  return render(
    <MemoryRouter>
      <NotificationsProvider>
        <NotificationsSlideOver onClose={() => {}} />
      </NotificationsProvider>
    </MemoryRouter>,
  )
}

describe('NotificationsSlideOver role-mention chip', () => {
  it('exposes its member list without requiring hover', async () => {
    renderPanel()
    const chip = await screen.findByText('@Board')
    expect(chip.getAttribute('title')).toMatch(/Alice Member/)
    expect(chip.getAttribute('title')).toMatch(/Bob Member/)
  })
})

describe('NotificationsSlideOver read-only demo', () => {
  afterEach(() => { demoState.demoLocked = false })

  it('still POSTs /notifications/mark-read when the demo is locked', async () => {
    // Per-user notification read state is allowlisted — a visitor's badge has to
    // clear or the panel looks broken.
    demoState.demoLocked = true
    const { apiFetch } = await import('../lib/api')
    vi.mocked(apiFetch).mockClear()
    renderPanel()
    await screen.findByText('@Board')
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/notifications/mark-read', expect.objectContaining({ method: 'POST' })))
  })
})
