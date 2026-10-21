/**
 * FeedActivityRow: bill titles in the expanded list use the shared bill-title
 * style (Source Serif 4, bold), as every other list of bills does (#911). Size
 * and one-line ellipsis stay as they were.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { FeedActivityRow } from './FeedActivityRow'
import type { FeedEvent } from '../lib/feedUtils'
import { BILL_TITLE_TEXT } from '../lib/textStyles'
import { fontSize } from '../styles/tokens'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

const event: FeedEvent = {
  id: 'evt-1', type: 'priority_set', billId: null, billNumber: '', billSessionSlug: null, billState: null,
  billTitle: '', billSummary: null, billPriority: null, billMatchType: null,
  userId: 'admin-1', userName: 'Ada Admin', userTitle: null,
  metadata: { priority: 'high', count: 3, billIds: ['b1', 'b2', 'b3'] },
  createdAt: '2026-06-03 10:00:00',
}

async function expand(bills: unknown[]) {
  apiFetchMock.mockResolvedValue({ bills })
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <FeedActivityRow event={event} />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('button', { name: /3 bills/ }))
}

const style = (el: HTMLElement) => el.getAttribute('style') ?? ''

describe('FeedActivityRow: bill titles in the expanded list', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('sets a lone bill\'s title in the shared bill-title style, keeping its size and ellipsis', async () => {
    await expand([{ id: 'b1', billNumber: 'HB101', title: 'Election Security Act', state: 'RI', sessionSlug: '2026', isDraft: false }])
    const title = (await screen.findByText('Election Security Act')) as HTMLElement
    expect(style(title)).toContain('Source Serif 4')
    expect(title.style.fontWeight).toBe(String(BILL_TITLE_TEXT.fontWeight))
    expect(style(title)).toContain(`font-size: ${fontSize.sm}`)
    expect(title.style.textOverflow).toBe('ellipsis')
    expect(title.style.whiteSpace).toBe('nowrap')
  })

  it('sets a companion group\'s title in the shared bill-title style, keeping its size and ellipsis', async () => {
    await expand([
      { id: 'b1', billNumber: 'HB101', title: 'Election Security Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: 'b1' },
      { id: 'b2', billNumber: 'SB202', title: 'Election Security Act', state: 'RI', sessionSlug: '2026', isDraft: false, groupKey: 'b1' },
    ])
    const title = (await screen.findByText('Election Security Act')) as HTMLElement
    expect(title.tagName).toBe('A')
    expect(style(title)).toContain('Source Serif 4')
    expect(title.style.fontWeight).toBe(String(BILL_TITLE_TEXT.fontWeight))
    expect(style(title)).toContain(`font-size: ${fontSize.sm}`)
    expect(title.style.textOverflow).toBe('ellipsis')
    expect(title.style.whiteSpace).toBe('nowrap')
  })

  it('sets an untitled draft\'s placeholder title in the same style', async () => {
    await expand([{ id: 'b3', billNumber: 'SB303', title: '', state: 'RI', sessionSlug: null, isDraft: true }])
    const title = (await screen.findByText('Untitled draft')) as HTMLElement
    expect(style(title)).toContain('Source Serif 4')
  })
})
