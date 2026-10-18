import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BillListPaneSummary } from './BillListPaneSummary'
import type { ListSummary } from './listSummary'

// The line under the pane's "Bills" header (#683): the summary, then the link
// that goes back to the list, right after it rather than at the far right.

const summaryOf = (text: string, filters: string[]): ListSummary =>
  ({ text, sortName: 'default order', filterCount: filters.length, filters, viewName: null })
const ONE_FILTER = summaryOf('1 filter · Sorted by default order', ['Status: Passed'])
const NO_FILTERS = summaryOf('All bills · Sorted by default order', [])

function renderSummary(summary: ListSummary, listUrl = '/bills?status=2') {
  return render(<MemoryRouter><BillListPaneSummary summary={summary} listUrl={listUrl} /></MemoryRouter>)
}
const row = () => document.querySelector('[data-pane-summary]') as HTMLElement

describe('BillListPaneSummary edit link', () => {
  it('reads "Edit filters" and goes to the list URL it was given', () => {
    renderSummary(ONE_FILTER, '/bills?status=2&sort=bill')
    const link = screen.getByRole('link', { name: 'Edit filters' })
    expect(link).toHaveAttribute('href', '/bills?status=2&sort=bill')
    expect(link).toHaveTextContent(/^Edit filters$/)
  })

  it('is no longer called just "Edit"', () => {
    renderSummary(ONE_FILTER)
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
  })

  it('comes directly after the summary text in the row, not after a spacer', () => {
    renderSummary(ONE_FILTER)
    const link = screen.getByRole('link', { name: 'Edit filters' })
    const summaryText = screen.getByText('1 filter · Sorted by default order')
    const kids = Array.from(row().children)
    expect(kids).toHaveLength(2)
    expect(kids[0].contains(summaryText)).toBe(true)
    expect(kids[1]).toBe(link)
  })

  it('does not stretch the summary across the row, so the link sits beside it and not at the far right', () => {
    renderSummary(ONE_FILTER)
    const first = row().children[0] as HTMLElement
    const link = screen.getByRole('link', { name: 'Edit filters' })
    // flex-grow 1 on the summary (the old layout) is what pushed the link to the right edge.
    expect(first.style.flexGrow === '' || first.style.flexGrow === '0').toBe(true)
    expect(first.style.flex).not.toMatch(/^1\b/)
    expect(link.style.marginLeft).not.toBe('auto')
    expect(row().style.justifyContent).not.toBe('space-between')
  })

  it('still lets a long summary shrink and wrap while the link keeps its size', () => {
    renderSummary(summaryOf('x'.repeat(200) + ' · Sorted by default order', []))
    const first = row().children[0] as HTMLElement
    const link = screen.getByRole('link', { name: 'Edit filters' })
    expect(first.style.minWidth).toBe('0px')
    expect(first.style.flexShrink === '' || first.style.flexShrink === '1' || /\b1\b/.test(first.style.flex)).toBe(true)
    expect(link.style.flexShrink).toBe('0')
    expect(link.style.whiteSpace).toBe('nowrap')
  })

  it('is placed the same when there are no filters', () => {
    renderSummary(NO_FILTERS)
    const kids = Array.from(row().children)
    expect(kids[1]).toBe(screen.getByRole('link', { name: 'Edit filters' }))
  })

  it('keeps the baseline alignment of the summary and the link', () => {
    renderSummary(ONE_FILTER)
    expect(row().style.alignItems).toBe('baseline')
  })
})
