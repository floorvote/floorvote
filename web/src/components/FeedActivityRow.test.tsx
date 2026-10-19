import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { FeedActivityRow } from './FeedActivityRow'
import type { FeedEvent } from '../lib/feedUtils'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

function makeEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: 'evt-1', type: 'priority_set', billId: null, billNumber: '', billSessionSlug: null, billState: null,
    billTitle: '', billSummary: null, billPriority: null, billMatchType: null,
    userId: 'admin-1', userName: 'Ada Admin', userTitle: null,
    metadata: { priority: 'high', count: 34, billIds: ['b1', 'b2', 'gone'] },
    createdAt: '2026-06-03 10:00:00', ...overrides,
  }
}

function renderRow(event: FeedEvent, props: { seenAt?: string | null; currentUserId?: string | null } = {}) {
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <FeedActivityRow event={event} {...props} />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
}

const BILLS = {
  bills: [
    { id: 'b1', billNumber: 'HB101', title: 'Election Security Act', state: 'RI', sessionSlug: '2026', isDraft: false },
    { id: 'b2', billNumber: 'SB202', title: '', state: 'RI', sessionSlug: null, isDraft: true },
  ],
}

describe('FeedActivityRow', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('renders a single sentence for the bulk edit, with no bill card', () => {
    renderRow(makeEvent())
    expect(screen.getByText('Ada Admin set priority to high on 34 bills')).toBeInTheDocument()
    expect(screen.queryByText('HB101')).not.toBeInTheDocument()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('lists the affected bills when expanded, each linking to its page, skipping deleted ones', async () => {
    apiFetchMock.mockResolvedValue(BILLS)
    renderRow(makeEvent())
    const toggle = screen.getByRole('button', { name: /34 bills/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)

    expect(apiFetchMock).toHaveBeenCalledWith('/feed/events/evt-1/bills')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const first = await screen.findByRole('link', { name: /HB101/ })
    expect(first).toHaveAttribute('href', '/RI/2026/HB101')
    expect(first).toHaveTextContent('Election Security Act')
    // A draft with no title reads "Untitled draft", and falls back to its id URL.
    const draft = screen.getByRole('link', { name: /SB202/ })
    expect(draft).toHaveAttribute('href', '/bills/b2')
    expect(draft).toHaveTextContent('Untitled draft')
    // The id whose bill is gone is just absent.
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('fetches once, and collapses and re-expands from what it has', async () => {
    apiFetchMock.mockResolvedValue(BILLS)
    renderRow(makeEvent())
    const toggle = screen.getByRole('button', { name: /34 bills/ })
    await userEvent.click(toggle)
    await screen.findByRole('link', { name: /HB101/ })
    await userEvent.click(toggle)
    expect(screen.queryByRole('link', { name: /HB101/ })).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(await screen.findByRole('link', { name: /HB101/ })).toBeInTheDocument()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('says so when none of the bills still exist', async () => {
    apiFetchMock.mockResolvedValue({ bills: [] })
    renderRow(makeEvent())
    await userEvent.click(screen.getByRole('button', { name: /34 bills/ }))
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
  })

  it('shows an error with a retry when the list fails to load', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(BILLS)
    renderRow(makeEvent())
    await userEvent.click(screen.getByRole('button', { name: /34 bills/ }))
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('link', { name: /HB101/ })).toBeInTheDocument()
  })

  it('marks it unread when someone else did it after the last visit, not when you did', () => {
    const { container, unmount } = renderRow(makeEvent(), { seenAt: '2026-06-03 09:00:00', currentUserId: 'someone-else' })
    expect(container.querySelector('[data-unread]')).not.toBeNull()
    unmount()
    const mine = renderRow(makeEvent(), { seenAt: '2026-06-03 09:00:00', currentUserId: 'admin-1' })
    expect(mine.container.querySelector('[data-unread]')).toBeNull()
  })

  describe('the new-matches row', () => {
    const matches = () => makeEvent({
      id: 'evt-m', type: 'new_matches', userId: 'system', userName: '', metadata: { billIds: ['b1', 'b2'] },
    })

    it('reads as one sentence, with the matched bills behind it', () => {
      renderRow(matches())
      expect(screen.getByText('2 new bills matched your keywords')).toBeInTheDocument()
      expect(screen.queryByText('HB101')).not.toBeInTheDocument()
      expect(apiFetchMock).not.toHaveBeenCalled()
    })

    it('expands to the matched bills, each linking to its page, and to the list of all new matches', async () => {
      apiFetchMock.mockResolvedValue(BILLS)
      renderRow(matches())
      const toggle = screen.getByRole('button', { name: /2 new bills matched/ })
      await userEvent.click(toggle)

      expect(apiFetchMock).toHaveBeenCalledWith('/feed/events/evt-m/bills')
      expect(await screen.findByRole('link', { name: /HB101/ })).toHaveAttribute('href', '/RI/2026/HB101')
      expect(screen.getByRole('link', { name: /SB202/ })).toHaveAttribute('href', '/bills/b2')
      expect(screen.getByRole('link', { name: /see all new matches/i })).toHaveAttribute('href', '/bills?newMatches=1')
    })

    // #638: a companion group is one policy, so it is one new match.
    it('reads a group of two matched members as one new bill, using the count the feed stored', () => {
      renderRow(makeEvent({ id: 'evt-g', type: 'new_matches', userId: 'system', userName: '', metadata: { billIds: ['b1', 'b2'], count: 1 } }))
      expect(screen.getByText('1 new bill matched your keywords')).toBeInTheDocument()
    })

    it('lists a group\'s members as one entry, with a badge link for each member bill', async () => {
      apiFetchMock.mockResolvedValue({
        bills: [
          { id: 'b1', billNumber: 'HB101', title: 'Election Security Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: 'b1' },
          { id: 'b2', billNumber: 'SB202', title: 'Election Security Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: 'b1' },
          { id: 'b3', billNumber: 'HB303', title: 'Ballot Access Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null },
        ],
      })
      const { container } = renderRow(makeEvent({ id: 'evt-g', type: 'new_matches', userId: 'system', userName: '', metadata: { billIds: ['b1', 'b2', 'b3'], count: 2 } }))
      await userEvent.click(screen.getByRole('button', { name: /2 new bills matched/ }))

      expect(await screen.findByRole('link', { name: /HB101/ })).toHaveAttribute('href', '/RI/2026/HB101')
      expect(screen.getByRole('link', { name: /SB202/ })).toHaveAttribute('href', '/RI/2026/SB202')
      expect(container.querySelectorAll('[data-bill-entry]')).toHaveLength(2)
      expect(screen.getAllByText('Election Security Act')).toHaveLength(1)
      const entry = screen.getByRole('link', { name: /SB202/ }).closest('[data-bill-entry]')!
      expect(entry).toContainElement(screen.getByRole('link', { name: /HB101/ }))
      expect(entry).not.toContainElement(screen.getByRole('link', { name: /HB303/ }))
    })

    it('lists bills with no group key one entry each, as before', async () => {
      apiFetchMock.mockResolvedValue(BILLS)
      const { container } = renderRow(matches())
      await userEvent.click(screen.getByRole('button', { name: /2 new bills matched/ }))
      await screen.findByRole('link', { name: /HB101/ })
      expect(container.querySelectorAll('[data-bill-entry]')).toHaveLength(2)
    })

    it('offers no list of all new matches on any other row', async () => {
      apiFetchMock.mockResolvedValue(BILLS)
      renderRow(makeEvent())
      await userEvent.click(screen.getByRole('button', { name: /34 bills/ }))
      await screen.findByRole('link', { name: /HB101/ })
      expect(screen.queryByRole('link', { name: /see all new matches/i })).not.toBeInTheDocument()
    })

    it('marks it unread for a member who has not seen it', () => {
      const { container } = renderRow(matches(), { seenAt: '2026-06-03 09:00:00', currentUserId: 'member-1' })
      expect(container.querySelector('[data-unread]')).not.toBeNull()
    })
  })

  it('renders an event with no bill list as a plain row with nothing to expand', async () => {
    renderRow(makeEvent({ type: 'bill_matched', metadata: {} }))
    expect(screen.getByText('Activity')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    await waitFor(() => expect(apiFetchMock).not.toHaveBeenCalled())
  })
})
