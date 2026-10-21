/**
 * FeedActivityRow: the chips of the expanded new-matches row (and of a bulk
 * edit, which shares its list) carry the sidebar's hover card, link to the bill
 * page, and keep a companion group as one entry (#923). The list is the shared
 * FeedBillList, so the chips, titles, drafts, and retry note are the ones the
 * no-priority row draws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { FeedActivityRow } from './FeedActivityRow'
import type { FeedEvent } from '../lib/feedUtils'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

type Listed = {
  id: string; billNumber: string; title: string; state: string; sessionSlug: string | null; isDraft: boolean
  groupKey?: string | null; summary?: string | null; priority?: 'high' | 'medium' | 'low' | null
}
const bill = (id: string, billNumber: string, more: Partial<Listed> = {}): Listed => ({
  id, billNumber, title: `Sample Act ${id}`, state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: null, summary: null, priority: null, ...more,
})

const matches = (billIds: string[]): FeedEvent => ({
  id: 'evt-m', type: 'new_matches', billId: null, billNumber: '', billSessionSlug: null, billState: null,
  billTitle: '', billSummary: null, billPriority: null, billMatchType: null, userId: 'system', userName: '', userTitle: null,
  metadata: { billIds }, createdAt: '2026-06-03 10:00:00',
})
const bulkEdit = (billIds: string[]): FeedEvent => ({
  ...matches(billIds), id: 'evt-b', type: 'priority_set', userId: 'admin-1', userName: 'Ada Admin',
  metadata: { priority: 'high', count: billIds.length, billIds },
})

// The lazy summary fetch the hover card makes for a bill whose summary the list didn't send.
function serve(bills: Listed[], lazy: Record<string, string | null> = {}) {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/feed/events/')) return { bills }
    const m = url.match(/^\/bills\/(.+)$/)
    if (m) return { tenantSummary: lazy[m[1]] ?? null }
    throw new Error(`unexpected ${url}`)
  })
}

async function renderOpen(event: FeedEvent, toggleName: RegExp) {
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  const view = render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <FeedActivityRow event={event} />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('button', { name: toggleName }))
  return view
}
const NEW_MATCHES = /new bills? matched/
const BULK = /bills/

const hover = (el: HTMLElement) => fireEvent.mouseEnter(el, { clientX: 100, clientY: 100 })

describe('the new-matches row: hover cards on the expanded list\'s chips', () => {
  beforeEach(() => { apiFetchMock.mockReset() })

  it('shows the card for a chip: the bill\'s title, its summary, and its priority', async () => {
    serve([bill('b1', 'HB101', { title: 'Ballot Access Act', summary: 'Moves the filing deadline.', priority: 'high' })])
    await renderOpen(matches(['b1']), NEW_MATCHES)
    hover(await screen.findByRole('link', { name: 'HB101' }))

    // The title is on the card as well as on the entry's own link.
    expect(await screen.findAllByText('Ballot Access Act')).toHaveLength(2)
    expect(screen.getByText('Moves the filing deadline.')).toBeInTheDocument()
    expect(screen.getByText('High priority')).toBeInTheDocument()
  })

  it('shows the card for a bill with no summary as its title and priority alone, after asking for the summary once', async () => {
    serve([bill('b1', 'HB101', { title: 'Ballot Access Act', summary: null, priority: 'low' })])
    await renderOpen(matches(['b1']), NEW_MATCHES)
    hover(await screen.findByRole('link', { name: 'HB101' }))

    expect(await screen.findAllByText('Ballot Access Act')).toHaveLength(2)
    expect(screen.getByText('Low priority')).toBeInTheDocument()
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/b1')
    expect(screen.queryByText('Moves the filing deadline.')).not.toBeInTheDocument()
  })

  it('shows no priority on the card for a bill with none', async () => {
    serve([bill('b1', 'HB101', { summary: 'A summary.', priority: null })])
    await renderOpen(matches(['b1']), NEW_MATCHES)
    hover(await screen.findByRole('link', { name: 'HB101' }))
    expect(await screen.findByText('A summary.')).toBeInTheDocument()
    expect(screen.queryByText(/priority$/)).not.toBeInTheDocument()
  })

  it('shows a summary the card had to fetch, when the list sent none', async () => {
    serve([bill('b1', 'HB101', { summary: null })], { b1: 'Fetched on hover.' })
    await renderOpen(matches(['b1']), NEW_MATCHES)
    hover(await screen.findByRole('link', { name: 'HB101' }))
    expect(await screen.findByText('Fetched on hover.')).toBeInTheDocument()
  })

  it('shows a draft\'s card with its "Untitled draft" name when it has no title', async () => {
    serve([bill('d1', 'LRD 12', { title: '', isDraft: true, state: 'RI', sessionSlug: null, summary: 'A drafted proposal.' })])
    await renderOpen(matches(['d1']), NEW_MATCHES)
    hover(await screen.findByRole('link', { name: /LRD 12/ }))
    expect(await screen.findByText('A drafted proposal.')).toBeInTheDocument()
    // The entry's title link and the card both name it.
    expect(screen.getAllByText('Untitled draft')).toHaveLength(2)
  })

  it('marks a draft\'s chip with the Draft chip beside it, as the list draws every draft', async () => {
    serve([bill('d1', 'LRD 12', { title: 'Drafted Act', isDraft: true, sessionSlug: null })])
    const { container } = await renderOpen(matches(['d1']), NEW_MATCHES)
    await screen.findByRole('link', { name: /LRD 12/ })
    expect(within(container.querySelector('[data-bill-entry]') as HTMLElement).getByText('Draft')).toBeInTheDocument()
  })

  it('links a chip and the title to the bill page', async () => {
    serve([bill('b1', 'HB101', { title: 'Ballot Access Act' }), bill('b2', 'SB202', { sessionSlug: null, title: 'Second Act' })])
    await renderOpen(matches(['b1', 'b2']), NEW_MATCHES)
    expect(await screen.findByRole('link', { name: 'HB101' })).toHaveAttribute('href', '/RI/2026/HB101')
    expect(screen.getByRole('link', { name: 'Ballot Access Act' })).toHaveAttribute('href', '/RI/2026/HB101')
    expect(screen.getByRole('link', { name: 'SB202' })).toHaveAttribute('href', '/bills/b2')
    expect(screen.getByRole('link', { name: 'Second Act' })).toHaveAttribute('href', '/bills/b2')
  })

  describe('a companion group', () => {
    const group = () => [
      bill('b1', 'HB101', { title: 'Election Security Act', groupKey: 'b1', summary: 'House version.', priority: 'medium' }),
      bill('b2', 'SB202', { title: 'Election Security Act', groupKey: 'b1', summary: 'Senate version.', priority: 'medium' }),
      bill('b3', 'HB303', { title: 'Ballot Access Act', groupKey: null }),
    ]

    it('is one entry, a chip for each member and the title once', async () => {
      serve(group())
      const { container } = await renderOpen(matches(['b1', 'b2', 'b3']), NEW_MATCHES)
      await screen.findByRole('link', { name: 'HB101' })
      const entries = container.querySelectorAll('[data-bill-entry]')
      expect(entries).toHaveLength(2)
      expect(within(entries[0] as HTMLElement).getByRole('link', { name: 'HB101' })).toHaveAttribute('href', '/RI/2026/HB101')
      expect(within(entries[0] as HTMLElement).getByRole('link', { name: 'SB202' })).toHaveAttribute('href', '/RI/2026/SB202')
      expect(within(entries[1] as HTMLElement).getByRole('link', { name: 'HB303' })).toBeInTheDocument()
      expect(screen.getAllByText('Election Security Act')).toHaveLength(1)
    })

    it('shows each member\'s own card from its chip', async () => {
      serve(group())
      await renderOpen(matches(['b1', 'b2', 'b3']), NEW_MATCHES)
      hover(await screen.findByRole('link', { name: 'SB202' }))
      expect(await screen.findByText('Senate version.')).toBeInTheDocument()
      expect(screen.getByText('Medium priority')).toBeInTheDocument()
      expect(screen.queryByText('House version.')).not.toBeInTheDocument()
    })
  })

  it('still offers "See all new matches", linking to the Bills list\'s new-matches view', async () => {
    serve([bill('b1', 'HB101')])
    await renderOpen(matches(['b1']), NEW_MATCHES)
    await screen.findByRole('link', { name: /HB101/ })
    expect(screen.getByRole('link', { name: /see all new matches/i })).toHaveAttribute('href', '/bills?newMatches=1')
  })

  it('offers "See all new matches" even when the list fails to load', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    await renderOpen(matches(['b1']), NEW_MATCHES)
    await screen.findByText(/couldn.t load/i)
    expect(screen.getByRole('link', { name: /see all new matches/i })).toHaveAttribute('href', '/bills?newMatches=1')
  })

  it('fetches the list from the row\'s own endpoint once, and shows it again from what it has', async () => {
    serve([bill('b1', 'HB101')])
    const view = await renderOpen(matches(['b1']), NEW_MATCHES)
    await screen.findByRole('link', { name: /HB101/ })
    const toggle = view.getByRole('button', { name: NEW_MATCHES })
    await userEvent.click(toggle)
    expect(screen.queryByRole('link', { name: /HB101/ })).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(await screen.findByRole('link', { name: /HB101/ })).toBeInTheDocument()
    expect(apiFetchMock.mock.calls.filter(([u]) => String(u).startsWith('/feed/events/'))).toEqual([['/feed/events/evt-m/bills']])
  })

  it('shows the retry note when the list fails, and the list once Try again works', async () => {
    // The list fails the first time it is asked for, and works the second.
    let failed = false
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/feed/events/')) {
        if (!failed) { failed = true; throw new Error('boom') }
        return { bills: [bill('b1', 'HB101', { summary: 'Retried.' })] }
      }
      throw new Error(`unexpected ${url}`)
    })
    await renderOpen(matches(['b1']), NEW_MATCHES)
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    hover(await screen.findByRole('link', { name: 'HB101' }))
    expect(await screen.findByText('Retried.')).toBeInTheDocument()
  })
})

describe('a bulk-edit row: the same list, with the hover card', () => {
  beforeEach(() => { apiFetchMock.mockReset() })

  it('shows the card for a chip', async () => {
    serve([bill('b1', 'HB101', { title: 'Ballot Access Act', summary: 'Moves the filing deadline.', priority: 'high' })])
    await renderOpen(bulkEdit(['b1']), /1 bill/)
    hover(await screen.findByRole('link', { name: 'HB101' }))
    expect(await screen.findByText('Moves the filing deadline.')).toBeInTheDocument()
    expect(screen.getByText('High priority')).toBeInTheDocument()
  })

  it('lists its bills as it did: each entry linking to its page, a group as one entry, with no "See all new matches"', async () => {
    serve([
      bill('b1', 'HB101', { groupKey: 'b1' }), bill('b2', 'SB202', { groupKey: 'b1' }), bill('b3', 'HB303'),
    ])
    const { container } = await renderOpen(bulkEdit(['b1', 'b2', 'b3']), BULK)
    expect(await screen.findByRole('link', { name: /HB101/ })).toHaveAttribute('href', '/RI/2026/HB101')
    expect(screen.getByRole('link', { name: /SB202/ })).toHaveAttribute('href', '/RI/2026/SB202')
    expect(screen.getByRole('link', { name: /HB303/ })).toHaveAttribute('href', '/RI/2026/HB303')
    expect(container.querySelectorAll('[data-bill-entry]')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: /see all new matches/i })).not.toBeInTheDocument()
    expect(apiFetchMock).toHaveBeenCalledWith('/feed/events/evt-b/bills')
  })

  it('says so when none of its bills still exist', async () => {
    serve([])
    await renderOpen(bulkEdit(['gone']), /1 bill/)
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
  })

  it('shows the retry note when its list fails to load, and the list once Try again works', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ bills: [bill('b1', 'HB101')] })
    await renderOpen(bulkEdit(['b1']), /1 bill/)
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('link', { name: /HB101/ })).toBeInTheDocument()
  })
})
