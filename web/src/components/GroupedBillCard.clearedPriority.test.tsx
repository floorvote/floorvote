import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { GroupedBillCard } from './GroupedBillCard'
import type { GroupedBillEvents } from '../lib/feedUtils'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }))

// A cleared priority reads in the feed card as the empty "no priority" square, not a filled one.
function renderCard(priority: string | null) {
  const group = {
    key: 'bill-1::2026-01-01', billId: 'bill-1', billNumber: 'HB 1', billState: 'RI', billSessionSlug: '2026rs',
    billTitle: 'Test Bill', billSummary: null, billPriority: null, billMatchType: 'keyword', date: '2026-01-01',
    events: [{
      id: 'e1', type: 'priority_set', billId: 'bill-1', billNumber: 'HB 1', billSessionSlug: '2026rs', billState: 'RI',
      billTitle: 'Test Bill', billSummary: null, billPriority: null, billMatchType: 'keyword',
      userId: 'u1', userName: 'Will', userTitle: null, metadata: { priority }, createdAt: '2026-01-01 10:00:00',
    }],
  } as unknown as GroupedBillEvents
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <GroupedBillCard group={group} />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
}

const HOLLOW = 'span[aria-hidden="true"][style*="border: 1px solid"]'

describe('GroupedBillCard: a priority row', () => {
  it('draws a cleared priority as a hollow square', () => {
    const { container } = renderCard(null)
    const sq = container.querySelector(HOLLOW)
    expect(sq).not.toBeNull()
    expect(sq).toHaveStyle({ background: 'transparent' })
  })

  it('keeps a set priority a filled square', () => {
    const { container } = renderCard('high')
    expect(container.querySelector(HOLLOW)).toBeNull()
  })
})
