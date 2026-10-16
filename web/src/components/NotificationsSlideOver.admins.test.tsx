/**
 * NotificationsSlideOver, an @admins mention
 *
 * The row says the recipient was reached as an admin, as the email does.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotificationsSlideOver } from './NotificationsSlideOver'
import { NotificationsProvider } from '../context/NotificationsContext'

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
}))

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/notifications') {
      return {
        unreadCount: 1,
        notifications: [{
          kind: 'mention', id: 'n1', commentId: 'c1', billId: 'b1',
          billNumber: 'SB123', billTitle: 'A test bill', billState: 'NJ', billIsDraft: false,
          sessionSlug: 'session-1',
          authorId: 'u1', authorName: 'Sam Member', authorSubtitle: null,
          commentPreview: 'preview',
          commentHtml: '<p>Please prioritize this.</p>',
          sourceType: 'admins', sourceLabel: null,
          createdAt: new Date().toISOString(), isUnread: true,
        }],
      }
    }
    if (path === '/roles') return []
    return {}
  }),
}))

describe('NotificationsSlideOver, @admins', () => {
  it('says the author mentioned the admins and that the member was reached as one', async () => {
    render(
      <MemoryRouter>
        <NotificationsProvider>
          <NotificationsSlideOver onClose={() => {}} />
        </NotificationsProvider>
      </MemoryRouter>,
    )

    const name = await screen.findByText('Sam Member')
    const headline = name.parentElement!.textContent!
    expect(headline).toContain('mentioned @admins')
    expect(headline).toContain("you're an admin")
    expect(headline).not.toContain('mentioned you')
  })
})
