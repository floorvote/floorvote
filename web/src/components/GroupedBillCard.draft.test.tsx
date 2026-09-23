/**
 * GroupedBillCard — draft marker
 *
 * The feed rendered a draft bill's badge as the solid navy default, because
 * this call site never passed `isDraft` (the feed payload didn't carry the
 * flag). api/src/routes/feed.ts now selects bills.isDraft and emits it as
 * billIsDraft; groupEventsByBillAndDay carries it onto the group; this card
 * passes it to BillBadge and pairs it with DraftChip.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'
import { GroupedBillCard } from './GroupedBillCard'
import type { GroupedBillEvents } from '../lib/feedUtils'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }))

function makeGroup(overrides: Partial<GroupedBillEvents> = {}): GroupedBillEvents {
  return {
    key: 'bill-1::2026-01-01',
    billId: 'bill-1',
    billNumber: 'HB 1',
    billState: 'RI',
    billSessionSlug: '2026rs',
    billTitle: 'Test Bill',
    billSummary: null,
    billPriority: null,
    billMatchType: 'keyword',
    date: '2026-01-01',
    events: [],
    ...overrides,
  }
}

function renderCard(group: GroupedBillEvents) {
  const value = { config: { states: ['RI'] } as AppConfig, multiState: false, loading: false }
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ConfigContext.Provider value={value}>
        <GroupedBillCard group={group} />
      </ConfigContext.Provider>
    </MemoryRouter>
  )
}

function badgeFor(container: HTMLElement): HTMLElement {
  const el = screen.getByText('HB 1')
  expect(container.contains(el)).toBe(true)
  return el
}

describe('GroupedBillCard draft marker', () => {
  it('renders the dashed badge variant for a draft bill', () => {
    const { container } = renderCard(makeGroup({ billIsDraft: true }))
    const badge = badgeFor(container)
    expect(badge.style.borderStyle === 'dashed' || /dashed/.test(badge.style.border)).toBe(true)
    expect(badge.style.background === 'transparent' || badge.style.background === '').toBe(true)
  })

  // Accessibility: the dashed border is decoration to a screen reader and
  // invisible to anyone who can't resolve a 1px border style, so "draft" must
  // also exist as text at this call site. DraftChip supplies it.
  it('pairs the dashed badge with the literal word "Draft"', () => {
    renderCard(makeGroup({ billIsDraft: true }))
    expect(screen.getByText('Draft')).toBeTruthy()
  })

  it('renders the solid badge and no Draft text for a filed bill', () => {
    const { container } = renderCard(makeGroup({ billIsDraft: false }))
    const badge = badgeFor(container)
    expect(/dashed/.test(badge.style.border)).toBe(false)
    expect(screen.queryByText('Draft')).toBeNull()
  })

  // billIsDraft is optional on the type (non-feed producers build
  // FeedEvent-shaped objects without it). Absent must read as "not a draft",
  // not as a dashed badge.
  it('treats an absent billIsDraft as not a draft', () => {
    const { container } = renderCard(makeGroup())
    expect(/dashed/.test(badgeFor(container).style.border)).toBe(false)
    expect(screen.queryByText('Draft')).toBeNull()
  })
})
