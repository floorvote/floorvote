/**
 * HearingRow — draft marker
 *
 * The sidebar hearing chips rendered a draft bill with the solid navy badge,
 * because /stats/sidebar's HearingBill shape carried no draft flag. It now
 * selects bills.isDraft and emits `isDraft` on every hearing bill, and this row
 * passes it to BillBadge.
 *
 * No visible DraftChip here, unlike BillRow/BillDetail/the feed card: this is a
 * wrapped chip row capped at six chips inside a sidebar whose minimum width is
 * 230px, and hanging a ~43px chip off every draft badge would wrap the row at a
 * fraction of the bills it holds today. The textual half of the signal is
 * BillBadge's `draftSrLabel` instead, which costs no layout.
 *
 * In practice no draft can reach this list today — hearings join tenant rows on
 * `externalId = 'legiscan:<n>'` and a draft is created with a null externalId —
 * so this is the shape being honest rather than a visible fix. See the
 * isDraft comment in api/src/routes/stats.ts.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HearingRow } from './HearingRow'
import type { HearingGroup, HearingBill } from './types'

function bill(overrides: Partial<HearingBill> = {}): HearingBill {
  return {
    id: 'b1', billNumber: 'H 100', title: 'Elections Act', summary: null,
    priority: 'high', state: 'RI', sessionSlug: null, myVote: null, isDraft: false,
    ...overrides,
  }
}

function renderRow(b: HearingBill) {
  const hearing: HearingGroup = {
    hearingKey: 'h1', eventHash: 'abc', type: 'Committee hearing',
    date: '2027-03-09', time: '10:00', location: 'Room 412',
    description: 'Judiciary Committee hearing',
    bills: [b],
  }
  return render(<MemoryRouter><HearingRow hearing={hearing} isFirst onClose={() => {}} /></MemoryRouter>)
}

describe('HearingRow draft marker', () => {
  it('renders the dashed badge variant for a draft bill', () => {
    renderRow(bill({ isDraft: true }))
    const badge = screen.getByText('H 100')
    expect(/dashed/.test(badge.style.border)).toBe(true)
    expect(badge.style.background === 'transparent' || badge.style.background === '').toBe(true)
  })

  it('renders the solid badge for a filed bill', () => {
    renderRow(bill({ isDraft: false }))
    const badge = screen.getByText('H 100')
    expect(/dashed/.test(badge.style.border)).toBe(false)
  })

  // The dashed border is decoration to a screen reader, so the chip must still
  // say "draft" somewhere. Here that is the badge's own accessible name.
  it('carries the word draft in the badge accessible name, with no visible chip', () => {
    const { container } = renderRow(bill({ isDraft: true }))
    expect(container.textContent).toMatch(/draft/i)
    // No layout-consuming chip: nothing renders the standalone visible word.
    expect(screen.queryByText('Draft')).toBeNull()
  })

  it('says nothing about drafts for a filed bill', () => {
    const { container } = renderRow(bill({ isDraft: false }))
    expect(container.textContent).not.toMatch(/draft/i)
  })
})
