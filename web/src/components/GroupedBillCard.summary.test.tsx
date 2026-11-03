/**
 * The Feed card's summary stays flattened text (#992): the card model carries
 * raw markdown for email to abridge, and the Feed flattens it itself.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { GroupedBillCard } from './GroupedBillCard'
import { groupEventsByBillAndDay, type FeedEvent } from '../lib/feedUtils'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }))

function ev(billSummary: string | null): FeedEvent {
  return {
    id: 'e', type: 'bill_updated', billId: 'h1', billNumber: 'H 101', billSessionSlug: '2026rs', billState: 'RI',
    billTitle: 'Permit Renewal Act', billSummary, billPriority: 'high', billMatchType: 'keyword', billGroupKey: 'h1',
    userId: 'u', userName: 'Ada', userTitle: null, metadata: { changes: [{ changeType: 'action_added', newValue: 'Passed' }] },
    createdAt: '2026-01-01T10:00:00Z',
  }
}

function renderCard(billSummary: string | null) {
  const [group] = groupEventsByBillAndDay([ev(billSummary)])
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <GroupedBillCard group={group} />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
}

describe('GroupedBillCard: the summary preview', () => {
  it('shows flattened text with no markdown symbols for a lead and a bold-label list', () => {
    const { container } = renderCard('Revises the permit process.\n- **Fees**: Lowers a fee.\n- **Forms**: Adds a form.')
    const text = container.textContent ?? ''
    expect(text).toContain('Revises the permit process. Fees: Lowers a fee. Forms: Adds a form.')
    expect(text).not.toContain('*')
    expect(text).not.toMatch(/(^|\s)- /)
    expect(container.querySelector('ul, li')).toBeNull()
  })

  it('flattens an HTML-form summary', () => {
    const { container } = renderCard('<p>Lead.</p><ul><li>One</li><li><strong>Two</strong></li></ul>')
    expect(container.textContent).toContain('Lead. One Two')
    expect(container.querySelector('ul, li, strong')).toBeNull()
  })

  it('flattens a one-line bold-label list', () => {
    const { container } = renderCard('Lead sentence. - **Fees**: Lowers a fee. - **Forms**: Adds a form.')
    expect(container.textContent).toContain('Lead sentence. Fees: Lowers a fee. Forms: Adds a form.')
  })

  it('renders no summary block when there is none', () => {
    const { container } = renderCard(null)
    expect(container.textContent).not.toContain('undefined')
    expect(container.textContent).toContain('Permit Renewal Act')
  })
})
