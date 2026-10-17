/**
 * GroupedBillCard — companion groups (#381)
 *
 * A group is one policy in the feed: one card holds the events of every member
 * bill, each row labeled with its bill's number, and a row opens its own bill.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { GroupedBillCard } from './GroupedBillCard'
import { groupEventsByBillAndDay, type FeedEvent } from '../lib/feedUtils'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }))

function ev(over: Partial<FeedEvent>): FeedEvent {
  return {
    id: 'e', type: 'bill_updated', billId: 'h1', billNumber: 'H 101', billSessionSlug: '2026rs', billState: 'RI',
    billTitle: 'Mail Ballot Processing', billSummary: null, billPriority: 'high', billMatchType: 'keyword', billGroupKey: 'h1',
    userId: 'u', userName: 'Ada', userTitle: null, metadata: {}, createdAt: '2026-01-01T10:00:00Z', ...over,
  }
}
const action = (newValue: string) => ({ changes: [{ changeType: 'action_added', newValue }] })

function Where() { return <div data-testid="where">{useLocation().pathname}</div> }
function renderCard(events: FeedEvent[]) {
  const [group] = groupEventsByBillAndDay(events)
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <GroupedBillCard group={group} />
        <Where />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
}

const both = () => [
  ev({ id: 'e2', billId: 's1', billNumber: 'S 202', metadata: action('Reported from committee'), createdAt: '2026-01-01T12:00:00Z' }),
  ev({ id: 'e1', metadata: action('Passed House committee'), createdAt: '2026-01-01T10:00:00Z' }),
]

describe('GroupedBillCard: a companion group', () => {
  it('shows one card with a badge for each bill that has events', () => {
    renderCard(both())
    expect(screen.getAllByText('H 101').length).toBeGreaterThan(0)
    expect(screen.getAllByText('S 202').length).toBeGreaterThan(0)
    // One title, one card.
    expect(screen.getAllByText('Mail Ballot Processing')).toHaveLength(1)
  })

  it('labels each event row with its bill\'s number', () => {
    renderCard(both())
    expect(screen.getByText('S 202: Action: Reported from committee')).toBeInTheDocument()
    expect(screen.getByText('H 101: Action: Passed House committee')).toBeInTheDocument()
  })

  it('labels a lone member\'s event too', () => {
    renderCard([ev({ id: 'e2', billId: 's1', billNumber: 'S 202', metadata: action('Signed') })])
    expect(screen.getByText(/^S 202:/)).toBeInTheDocument()
  })

  it('opens the bill an event is on, not the card\'s first bill', () => {
    renderCard(both())
    fireEvent.click(screen.getByText(/^S 202:/))
    expect(screen.getByTestId('where').textContent).toBe('/RI/2026rs/S 202')
  })

  it('opens the bill at the row\'s section when the row has one', () => {
    renderCard([ev({ id: 'e2', billId: 's1', billNumber: 'S 202', type: 'comment_added', metadata: { preview: 'hi', commentId: 'c9' } })])
    fireEvent.click(screen.getByText(/^S 202:/))
    // router location has no hash in pathname; the destination is the senate bill, not the house one.
    expect(screen.getByTestId('where').textContent).toBe('/RI/2026rs/S 202')
  })

  it('opens the card\'s newest bill from the header', () => {
    renderCard(both())
    fireEvent.click(screen.getByText('Mail Ballot Processing'))
    expect(screen.getByTestId('where').textContent).toBe('/RI/2026rs/S 202')
  })

  it('marks a draft member with the dashed badge, and the filed one solid', () => {
    renderCard([
      ev({ id: 'e2', billId: 's1', billNumber: 'S 202', billIsDraft: true, createdAt: '2026-01-01T12:00:00Z' }),
      ev({ id: 'e1' }),
    ])
    const dashed = (el: HTMLElement) => el.style.borderStyle === 'dashed' || /dashed/.test(el.style.border)
    expect(dashed(screen.getAllByText('S 202')[0])).toBe(true)
    expect(dashed(screen.getAllByText('H 101')[0])).toBe(false)
  })

  it('leaves an ungrouped bill\'s card as it was: no labels, no second badge', () => {
    renderCard([ev({ billGroupKey: null, metadata: action('Referred') })])
    expect(screen.queryByText(/^H 101:/)).toBeNull()
    expect(screen.getAllByText('H 101')).toHaveLength(1)
    // An exact match: a label in front would not be this text.
    expect(screen.getByText('Action: Referred')).toBeInTheDocument()
  })
})
