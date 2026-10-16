/**
 * NotificationsSlideOver — rendering by kind
 *
 * GET /notifications returns rows discriminated on `kind`, and the panel picks a
 * renderer per kind. A kind this build has no renderer for (a newer server) is
 * skipped, never drawn as a mention.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotificationsSlideOver } from './NotificationsSlideOver'
import { NotificationsProvider } from '../context/NotificationsContext'

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
}))

const row = (over: Record<string, unknown>) => ({
  commentId: 'c1', billId: 'b1',
  billNumber: 'SB123', billTitle: 'A test bill', billState: 'NJ', billIsDraft: false,
  sessionSlug: 'session-1',
  authorId: 'u1', authorName: 'Alice Author', authorTitle: null,
  commentPreview: 'preview', commentHtml: '<p>Please review.</p>',
  sourceType: 'user', sourceLabel: null,
  createdAt: new Date().toISOString(), isUnread: true,
  ...over,
})

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/notifications') {
      return {
        unreadCount: 2,
        notifications: [
          row({ kind: 'mention', id: 'n1', authorName: 'Alice Author' }),
          row({
            kind: 'reply', id: 'n3', commentId: 'c3', authorName: 'Rae Replier', isUnread: false,
            billNumber: 'HB9', billTitle: 'The replied bill', commentHtml: '<p>I disagree with section two.</p>',
          }),
          row({ kind: 'some_future_kind', id: 'n2', authorName: 'Zed Future' }),
        ],
      }
    }
    if (path === '/roles') return []
    return {}
  }),
}))

describe('NotificationsSlideOver kinds', () => {
  it('renders a mention row and a reply row, and skips a kind it has no renderer for', async () => {
    render(
      <MemoryRouter>
        <NotificationsProvider>
          <NotificationsSlideOver onClose={() => {}} />
        </NotificationsProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Alice Author')).toBeInTheDocument()
    expect(screen.getByText('mentioned you')).toBeInTheDocument()
    expect(screen.queryByText('Zed Future')).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('renders a reply as the author commenting on a bill the member commented on, linked to the comment', async () => {
    render(
      <MemoryRouter>
        <NotificationsProvider>
          <NotificationsSlideOver onClose={() => {}} />
        </NotificationsProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Rae Replier')).toBeInTheDocument()
    expect(screen.getByText("commented on a bill you've commented on")).toBeInTheDocument()
    expect(screen.getByText('I disagree with section two.')).toBeInTheDocument()
    expect(screen.getByText('HB9')).toBeInTheDocument()
    const link = screen.getByText('Rae Replier').closest('a')!
    expect(link.getAttribute('href')).toMatch(/#comment-c3$/)
  })

  it('titles the panel as notifications, not mentions', async () => {
    render(
      <MemoryRouter>
        <NotificationsProvider>
          <NotificationsSlideOver onClose={() => {}} />
        </NotificationsProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Alice Author')
    expect(screen.getByRole('dialog', { name: 'Notifications' })).toBeInTheDocument()
  })
})
