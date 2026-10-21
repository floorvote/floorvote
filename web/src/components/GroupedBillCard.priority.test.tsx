/**
 * GroupedBillCard: the priority control (#911)
 *
 * An admin gets the same dropdown a Bills list row has (CompactPrioritySelect)
 * at the card's top right: "Set priority" for no priority, the current one
 * otherwise, and the amber "New · Set priority" with Dismiss for an untriaged
 * new match. A member keeps the read-only badge (and the Bills list's read-only
 * "New match" label). The control never opens the bill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { GroupedBillCard } from './GroupedBillCard'
import { groupEventsByBillAndDay, type FeedEvent, type GroupedBillEvents } from '../lib/feedUtils'
import { expectAmber, expectNotAmber } from '../test/amberStyle'
import { expectClosedLabel } from '../test/closedLabel'

const apiFetchMock = vi.fn()
vi.mock('../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

function makeGroup(over: Partial<GroupedBillEvents> = {}): GroupedBillEvents {
  return {
    key: 'bill-1::2026-01-01', billId: 'bill-1', billNumber: 'HB 1', billState: 'RI', billSessionSlug: '2026rs',
    billTitle: 'Test Bill', billSummary: null, billPriority: null, billMatchType: 'keyword', billNewMatch: false,
    date: '2026-01-01', events: [],
    ...over,
  }
}

function ev(over: Partial<FeedEvent>): FeedEvent {
  return {
    id: 'e', type: 'comment_added', billId: 'h1', billNumber: 'H 101', billSessionSlug: '2026rs', billState: 'RI',
    billTitle: 'Mail Ballot Processing', billSummary: null, billPriority: null, billMatchType: 'keyword', billGroupKey: 'h1',
    billNewMatch: false, userId: 'u', userName: 'Ada', userTitle: null, metadata: { preview: 'hi' }, createdAt: '2026-01-01T10:00:00Z', ...over,
  }
}

function Where() { return <div data-testid="where">{useLocation().pathname}</div> }

function renderCard(group: GroupedBillEvents, props: { isAdmin?: boolean } = {}) {
  const onPriorityChange = vi.fn()
  const onTriageDismiss = vi.fn()
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  const utils = render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <GroupedBillCard group={group} onPriorityChange={onPriorityChange} onTriageDismiss={onTriageDismiss} {...props} />
        <Where />
      </ConfigContext.Provider>
    </MemoryRouter>,
  )
  return { ...utils, onPriorityChange, onTriageDismiss }
}

const select = () => screen.getByRole('combobox', { name: /priority/i })
const noSelect = () => expect(screen.queryByRole('combobox')).toBeNull()
const optionLabels = (s: HTMLElement) => within(s).getAllByRole('option').map(o => o.textContent)

beforeEach(() => {
  apiFetchMock.mockReset()
  vi.spyOn(window, 'open').mockImplementation(() => null)
})
afterEach(() => vi.restoreAllMocks())

describe('GroupedBillCard priority control: an admin', () => {
  it('sees "Set priority" when the bill has none', () => {
    renderCard(makeGroup(), { isAdmin: true })
    expectClosedLabel(select(), 'Set priority')
    expectNotAmber(select())
  })

  it('sees the current priority when the bill has one', () => {
    renderCard(makeGroup({ billPriority: 'medium' }), { isAdmin: true })
    expect(select()).toHaveDisplayValue('Medium Priority')
    expect(select()).toHaveValue('medium')
  })

  it('does not also draw the read-only badge beside the control', () => {
    renderCard(makeGroup({ billPriority: 'high' }), { isAdmin: true })
    // The dropdown shows the priority; the member's badge ("High priority") is not drawn too.
    expect(select()).toHaveValue('high')
    expect(screen.queryByText('High priority')).toBeNull()
  })

  it('choosing a priority PATCHes that bill and reports the new value', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high', promoted: false })
    const { onPriorityChange, onTriageDismiss } = renderCard(makeGroup(), { isAdmin: true })
    fireEvent.change(select(), { target: { value: 'high' } })
    await waitFor(() => expect(onPriorityChange).toHaveBeenCalledWith('high'))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/bill-1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })
    expect(onTriageDismiss).not.toHaveBeenCalled()
  })

  it('clearing the priority PATCHes null and reports null', async () => {
    apiFetchMock.mockResolvedValue({ priority: null, promoted: false })
    const { onPriorityChange } = renderCard(makeGroup({ billPriority: 'low' }), { isAdmin: true })
    fireEvent.change(select(), { target: { value: '__none__' } })
    await waitFor(() => expect(onPriorityChange).toHaveBeenCalledWith(null))
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/bill-1/priority', { method: 'PATCH', body: JSON.stringify({ priority: null }) })
  })

  it('says so when the server refuses to save, hanging the message from the control\'s right edge so the card does not clip it', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    renderCard(makeGroup(), { isAdmin: true })
    fireEvent.change(select(), { target: { value: 'high' } })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't save priority. Try again.")
    expect(alert.style.right).toBe('0px')
  })

  it('does not report a priority the server refused to save', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    const { onPriorityChange } = renderCard(makeGroup({ billPriority: 'low' }), { isAdmin: true })
    fireEvent.change(select(), { target: { value: 'high' } })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 0))
    expect(onPriorityChange).not.toHaveBeenCalled()
    // The card still shows what is saved, as a Bills list row does.
    expect(select()).toHaveValue('low')
  })
})

describe('GroupedBillCard priority control: an untriaged new match', () => {
  const NEW = { billNewMatch: true }

  it('is the amber "New · Set priority" dropdown with Dismiss as its last option', () => {
    renderCard(makeGroup(NEW), { isAdmin: true })
    expectClosedLabel(select(), 'New · Set priority')
    expectAmber(select())
    expect(optionLabels(select())).toEqual(['No priority', 'High Priority', 'Medium Priority', 'Low Priority', 'Dismiss (reviewed, no priority)'])
  })

  it('Dismiss triages the bill, reports it, and announces it, without setting a priority', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    const { onPriorityChange, onTriageDismiss } = renderCard(makeGroup(NEW), { isAdmin: true })
    fireEvent.change(select(), { target: { value: 'dismiss' } })
    await waitFor(() => expect(onTriageDismiss).toHaveBeenCalledTimes(1))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/bill-1/triage-dismiss', { method: 'PATCH' })
    expect(onPriorityChange).not.toHaveBeenCalled()
    expect(screen.getByTestId('dismiss-announcement')).toHaveTextContent('Dismissed')
  })

  it('a failed Dismiss does not report a triage', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'))
    const { onTriageDismiss } = renderCard(makeGroup(NEW), { isAdmin: true })
    fireEvent.change(select(), { target: { value: 'dismiss' } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't dismiss/i)
    expect(onTriageDismiss).not.toHaveBeenCalled()
  })

  it('is plain once it is no longer a new match', () => {
    renderCard(makeGroup({ billNewMatch: false }), { isAdmin: true })
    expectNotAmber(select())
    expect(optionLabels(select())).not.toContain('Dismiss (reviewed, no priority)')
  })
})

describe('GroupedBillCard priority control: a member', () => {
  it('sees the read-only badge when a priority is set, and no dropdown', () => {
    renderCard(makeGroup({ billPriority: 'high' }))
    expect(screen.getByText('High priority')).toBeInTheDocument()
    noSelect()
  })

  it('sees nothing when no priority is set', () => {
    renderCard(makeGroup())
    noSelect()
    expect(screen.queryByText(/priority/i)).toBeNull()
    expect(screen.queryByText('New match')).toBeNull()
  })

  it('sees the read-only "New match" label on an untriaged new match, as on the Bills list', () => {
    renderCard(makeGroup({ billNewMatch: true }))
    expect(screen.getByText('New match')).toBeInTheDocument()
    noSelect()
    expect(screen.queryByText(/dismiss/i)).toBeNull()
  })

  it('sees the badge, not the "New match" label, once a priority is set', () => {
    renderCard(makeGroup({ billPriority: 'low', billNewMatch: true }))
    expect(screen.getByText('Low priority')).toBeInTheDocument()
    expect(screen.queryByText('New match')).toBeNull()
  })
})

describe('GroupedBillCard priority control never opens the bill', () => {
  const where = () => screen.getByTestId('where').textContent

  it('a click on the control does not navigate', () => {
    renderCard(makeGroup(), { isAdmin: true })
    fireEvent.click(select())
    expect(where()).toBe('/feed')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('a modified click (cmd, ctrl, shift) on the control does not open a tab', () => {
    renderCard(makeGroup(), { isAdmin: true })
    fireEvent.click(select(), { metaKey: true })
    fireEvent.click(select(), { ctrlKey: true })
    fireEvent.click(select(), { shiftKey: true })
    expect(window.open).not.toHaveBeenCalled()
    expect(where()).toBe('/feed')
  })

  it('a middle-click on the control does not open a tab', () => {
    renderCard(makeGroup(), { isAdmin: true })
    fireEvent(select(), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(window.open).not.toHaveBeenCalled()
    expect(where()).toBe('/feed')
  })

  it('a middle-click on the control of a new match does not open a tab', () => {
    renderCard(makeGroup({ billNewMatch: true }), { isAdmin: true })
    fireEvent(select(), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(window.open).not.toHaveBeenCalled()
  })

  it('keyboard use (Enter, Space, arrows) and changing the value do not navigate', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'high' })
    renderCard(makeGroup(), { isAdmin: true })
    select().focus()
    for (const key of ['Enter', ' ', 'ArrowDown']) {
      fireEvent.keyDown(select(), { key })
      fireEvent.keyUp(select(), { key })
    }
    fireEvent.change(select(), { target: { value: 'high' } })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
    expect(where()).toBe('/feed')
    expect(window.open).not.toHaveBeenCalled()
  })

  it('the rest of the card still opens the bill', () => {
    renderCard(makeGroup(), { isAdmin: true })
    fireEvent.click(screen.getByText('Test Bill'))
    expect(where()).toBe('/RI/2026rs/HB 1')
  })
})

describe('GroupedBillCard priority control: a companion group', () => {
  const group = (billPriority: 'high' | 'medium' | 'low' | null = 'medium', billNewMatch = false) => groupEventsByBillAndDay([
    ev({ id: 'e2', billId: 's1', billNumber: 'S 202', billPriority, billNewMatch, createdAt: '2026-01-01T12:00:00Z' }),
    ev({ id: 'e1', billId: 'h1', billNumber: 'H 101', billPriority, billNewMatch, createdAt: '2026-01-01T10:00:00Z' }),
  ] as FeedEvent[])[0]

  it('shows the group\'s current priority, which any member may hold', () => {
    renderCard(group('high'), { isAdmin: true })
    expect(select()).toHaveValue('high')
    // One control for the whole card, not one per bill badge.
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
  })

  it('sets the group\'s priority through the card\'s own bill, the way a Bills list group row does through its lead', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'low' })
    const { onPriorityChange } = renderCard(group(null), { isAdmin: true })
    fireEvent.change(select(), { target: { value: 'low' } })
    await waitFor(() => expect(onPriorityChange).toHaveBeenCalledWith('low'))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/s1/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'low' }) })
  })

  it('shows a group that is a new match as the amber dropdown, and Dismiss triages through the card\'s bill', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    const { onTriageDismiss } = renderCard(group(null, true), { isAdmin: true })
    expectAmber(select())
    fireEvent.change(select(), { target: { value: 'dismiss' } })
    await waitFor(() => expect(onTriageDismiss).toHaveBeenCalled())
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/s1/triage-dismiss', { method: 'PATCH' })
  })

  it('shows a member the group\'s priority badge, once', () => {
    renderCard(group('high'))
    expect(screen.getAllByText('High priority')).toHaveLength(1)
    noSelect()
  })

  it('does not navigate when the control is used', () => {
    renderCard(group('high'), { isAdmin: true })
    fireEvent.click(select())
    expect(screen.getByTestId('where').textContent).toBe('/feed')
  })
})

describe('GroupedBillCard priority control: a draft bill', () => {
  it('gets the same control as on the Bills list, PATCHing the draft\'s id', async () => {
    apiFetchMock.mockResolvedValue({ priority: 'medium' })
    const { onPriorityChange } = renderCard(makeGroup({ billIsDraft: true, billId: 'draft-7', billMatchType: null }), { isAdmin: true })
    expectClosedLabel(select(), 'Set priority')
    expectNotAmber(select())
    fireEvent.change(select(), { target: { value: 'medium' } })
    await waitFor(() => expect(onPriorityChange).toHaveBeenCalledWith('medium'))
    expect(apiFetchMock).toHaveBeenCalledWith('/bills/draft-7/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'medium' }) })
  })

  it('shows a member a draft\'s priority badge as today', () => {
    renderCard(makeGroup({ billIsDraft: true, billMatchType: null, billPriority: 'low' }))
    expect(screen.getByText('Low priority')).toBeInTheDocument()
    noSelect()
  })
})
