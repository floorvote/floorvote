/**
 * NotificationsSlideOver — reaction rows
 *
 * GET /notifications collapses a comment's reaction notifications into one row
 * (api/src/lib/notifications.ts). The panel names who reacted, links to the
 * member's own comment, and shows the unread rail like any other kind.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotificationsSlideOver } from './NotificationsSlideOver'
import { NotificationsProvider } from '../context/NotificationsContext'

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
}))

const reactor = (id: string, name: string | null) => ({ id, name })

const row = (over: Record<string, unknown>) => ({
  kind: 'reaction', commentId: 'c1', billId: 'b1',
  billNumber: 'SB123', billTitle: 'A test bill', billState: 'NJ', billIsDraft: false,
  sessionSlug: 'session-1',
  commentPreview: 'preview', commentHtml: '<p>My original comment.</p>',
  createdAt: new Date().toISOString(), isUnread: true,
  ...over,
})

// `later`, when set, is what every GET after the first returns.
const payload = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], later: null as Record<string, unknown>[] | null, gets: 0 }))

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/notifications') {
      const rows = payload.gets++ > 0 && payload.later ? payload.later : payload.rows
      return { unreadCount: rows.filter(r => r.isUnread).length, notifications: rows }
    }
    if (path === '/roles') return []
    return {}
  }),
}))

// The names are bold, so a sentence spans two text nodes. Match the element
// whose whole text is the sentence (the relative time sits in the parent).
const sentence = (text: string) =>
  (_: string, el: Element | null) => el?.tagName === 'DIV' && el.textContent === text

function renderPanel(rows: Record<string, unknown>[], later: Record<string, unknown>[] | null = null) {
  payload.rows = rows
  payload.later = later
  payload.gets = 0
  return render(
    <MemoryRouter>
      <NotificationsProvider>
        <NotificationsSlideOver onClose={() => {}} />
      </NotificationsProvider>
    </MemoryRouter>,
  )
}

describe('NotificationsSlideOver reaction rows', () => {
  it('collapses many reactors into one row naming the newest and counting the rest', async () => {
    renderPanel([row({
      id: 'r1',
      reactors: [reactor('u1', 'Jordan Lee'), reactor('u2', 'Sam'), reactor('u3', 'Pat'), reactor('u4', 'Kai'),
        reactor('u5', 'Lou'), reactor('u6', 'Max'), reactor('u7', 'Ned'), reactor('u8', 'Oz')],
      reactorCount: 8,
    })])

    expect(await screen.findByText(sentence('Jordan Lee and 7 others reacted to your comment'))).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('names one reactor, then two', async () => {
    renderPanel([
      row({ id: 'r1', commentId: 'c1', reactors: [reactor('u1', 'Jordan Lee')], reactorCount: 1 }),
      row({ id: 'r2', commentId: 'c2', reactors: [reactor('u2', 'Sam'), reactor('u3', 'Pat')], reactorCount: 2 }),
    ])

    expect(await screen.findByText(sentence('Jordan Lee reacted to your comment'))).toBeInTheDocument()
    expect(screen.getByText(sentence('Sam and Pat reacted to your comment'))).toBeInTheDocument()
  })

  it('says one other, not 1 others', async () => {
    renderPanel([row({
      id: 'r1', reactors: [reactor('u1', 'Jordan Lee'), reactor('u2', 'Sam'), reactor('u3', 'Pat')], reactorCount: 3,
    })])
    expect(await screen.findByText(sentence('Jordan Lee and 2 others reacted to your comment'))).toBeInTheDocument()
  })

  it('falls back to Someone for a reactor with no name', async () => {
    renderPanel([row({ id: 'r1', reactors: [reactor('u1', null)], reactorCount: 1 })])
    expect(await screen.findByText(sentence('Someone reacted to your comment'))).toBeInTheDocument()
  })

  it('shows the member\'s comment and links to it', async () => {
    renderPanel([row({ id: 'r1', commentId: 'c9', reactors: [reactor('u1', 'Jordan Lee')], reactorCount: 1 })])

    expect(await screen.findByText('My original comment.')).toBeInTheDocument()
    expect(screen.getByText('SB123')).toBeInTheDocument()
    const link = screen.getByText(sentence('Jordan Lee reacted to your comment')).closest('a')!
    expect(link.getAttribute('href')).toMatch(/#comment-c9$/)
  })

  it('marks an unread row with the unread rail and a read row without it', async () => {
    renderPanel([
      row({ id: 'r1', commentId: 'c1', isUnread: true, reactors: [reactor('u1', 'Jordan Lee')], reactorCount: 1 }),
      row({ id: 'r2', commentId: 'c2', isUnread: false, reactors: [reactor('u2', 'Sam')], reactorCount: 1 }),
    ])

    const unread = (await screen.findByText(sentence('Jordan Lee reacted to your comment'))).closest('a')!
    const read = screen.getByText(sentence('Sam reacted to your comment')).closest('a')!
    expect(unread.style.borderLeft).toMatch(/3px solid (?!transparent)/)
    expect(read.style.borderLeft).toMatch(/transparent/)
  })

  it('replaces a shown row with its fresh version when a reaction arrives as the panel opens', async () => {
    const id = 'reaction:c1'
    renderPanel(
      [row({ id, isUnread: false, reactors: [reactor('u2', 'Sam')], reactorCount: 1 })],
      [row({ id, isUnread: true, reactors: [reactor('u1', 'Jordan Lee'), reactor('u2', 'Sam')], reactorCount: 2 })],
    )

    const fresh = (await screen.findByText(sentence('Jordan Lee and Sam reacted to your comment'))).closest('a')!
    expect(fresh.style.borderLeft).toMatch(/3px solid (?!transparent)/)
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
})
