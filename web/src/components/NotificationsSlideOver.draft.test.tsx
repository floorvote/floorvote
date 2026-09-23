/**
 * NotificationsSlideOver — draft marker
 *
 * A mention's bill footer rendered a draft with the solid navy badge, because
 * GET /notifications carried no draft flag. The route now selects bills.isDraft
 * and emits `billIsDraft`; the footer passes it to BillBadge and pairs it with
 * a mini DraftChip.
 *
 * There is room for the visible chip here, unlike the sidebar hearing chips or
 * the picker's pills: the footer is a single flex line whose only flexible item
 * is the bill title, which already ellipsizes by design, so the chip shortens
 * the title rather than wrapping or clipping anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NotificationsSlideOver } from './NotificationsSlideOver'
import { NotificationsProvider } from '../context/NotificationsContext'
import type { Mention } from '../context/NotificationsContext'

const state = vi.hoisted(() => ({ billIsDraft: false }))

vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true, demoResetAt: 'epoch-1' }),
}))

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/notifications') {
      const mention: Mention = {
        id: 'm1', commentId: 'c1', billId: 'b1',
        billNumber: 'SB123', billTitle: 'A test bill', billState: 'NJ',
        billIsDraft: state.billIsDraft,
        sessionSlug: 'session-1',
        authorName: 'Alice Author', authorSubtitle: null,
        commentPreview: 'preview', commentHtml: '<p>Please review.</p>',
        sourceType: 'user', sourceLabel: null,
        createdAt: new Date().toISOString(), isUnread: true,
      }
      return { unreadCount: 1, mentions: [mention] }
    }
    if (path === '/roles') return []
    return {}
  }),
}))

async function renderPanel(billIsDraft: boolean) {
  state.billIsDraft = billIsDraft
  const result = render(
    <MemoryRouter>
      <NotificationsProvider>
        <NotificationsSlideOver onClose={() => {}} />
      </NotificationsProvider>
    </MemoryRouter>,
  )
  await screen.findByText('SB123')
  return result
}

describe('NotificationsSlideOver draft marker', () => {
  beforeEach(() => { state.billIsDraft = false })

  it('renders the dashed badge and a visible Draft chip for a draft bill', async () => {
    await renderPanel(true)
    const badge = screen.getByText('SB123')
    expect(/dashed/.test(badge.style.border)).toBe(true)
    expect(badge.style.background === 'transparent' || badge.style.background === '').toBe(true)
    expect(screen.getByText('Draft')).toBeTruthy()
  })

  it('renders the solid badge and no Draft text for a filed bill', async () => {
    await renderPanel(false)
    expect(/dashed/.test(screen.getByText('SB123').style.border)).toBe(false)
    expect(screen.queryByText('Draft')).toBeNull()
  })

  // Mini, because it shares the footer line with a mini badge.
  it('uses the mini chip scale', async () => {
    await renderPanel(true)
    expect(screen.getByText('Draft').style.padding).toBe('2px 6px')
  })
})
