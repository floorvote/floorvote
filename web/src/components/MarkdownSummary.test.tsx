import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarkdownSummary } from './MarkdownSummary'

// `ul > li` also matches items of a NESTED list, so scope to the outermost
// list when counting top-level items.
const topItems = (c: HTMLElement) =>
  [...(c.querySelector('ul, ol')?.querySelectorAll(':scope > li') ?? [])]

describe('MarkdownSummary', () => {
  // The shape that motivated the fix: an AI bill summary that opens with a
  // lead sentence, lists its provisions, and closes with an effective-date
  // line. The trailing line used to collapse the entire block into one
  // paragraph with the "- " markers left inline.
  const LEAD_LIST_TRAILER = [
    'Imposes new daily reporting requirements on county and city clerks:',
    '- **Daily Reporting:** clerks must post the previous day totals by 11 a.m.',
    '- **Monthly Voter List:** clerks must publish a list on the first business day.',
    'Effective upon passage for preparatory tasks; all other provisions January 1, 2026.',
  ].join('\n')

  it('renders a list that has text both before and after it', () => {
    const { container } = render(<MarkdownSummary>{LEAD_LIST_TRAILER}</MarkdownSummary>)
    expect(container.querySelectorAll('ul')).toHaveLength(1)
    expect(container.querySelectorAll('li')).toHaveLength(2)
    // Lead and trailer are their own paragraphs, in order, around the list.
    const paras = [...container.querySelectorAll('p')].map(p => p.textContent ?? '')
    expect(paras).toHaveLength(2)
    expect(paras[0]).toContain('Imposes new daily reporting')
    expect(paras[1]).toContain('Effective upon passage')
    // The regression: bullet markers must not survive as literal text.
    expect(container.textContent).not.toContain('- **Daily Reporting')
    expect(container.textContent).not.toContain('- Daily Reporting')
  })

  it('keeps the bold label inside a list item', () => {
    const { container } = render(<MarkdownSummary>{LEAD_LIST_TRAILER}</MarkdownSummary>)
    const strongs = [...container.querySelectorAll('li strong')].map(s => s.textContent)
    expect(strongs).toEqual(['Daily Reporting:', 'Monthly Voter List:'])
  })

  it('still renders a paragraph followed by a list', () => {
    const { container } = render(<MarkdownSummary>{'Intro line:\n- one\n- two'}</MarkdownSummary>)
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('still renders a bare list with no surrounding prose', () => {
    const { container } = render(<MarkdownSummary>{'- one\n- two\n- three'}</MarkdownSummary>)
    expect(container.querySelectorAll('p')).toHaveLength(0)
    expect(container.querySelectorAll('li')).toHaveLength(3)
  })

  it('renders an ordered list that is followed by prose', () => {
    const { container } = render(<MarkdownSummary>{'Steps:\n1. first\n2. second\nDone.'}</MarkdownSummary>)
    expect(container.querySelectorAll('ol')).toHaveLength(1)
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(container.querySelectorAll('p')).toHaveLength(2)
  })

  it('renders alternating prose and lists in order', () => {
    const { container } = render(
      <MarkdownSummary>{'A:\n- one\nB:\n- two\nC.'}</MarkdownSummary>
    )
    expect(container.querySelectorAll('ul')).toHaveLength(2)
    expect(container.querySelectorAll('p')).toHaveLength(3)
    // The rendered blocks live on .markdown-summary; a sibling <style> now
    // carries the scoped CSS, so select the host rather than the first child.
    const host = container.querySelector('.markdown-summary')!
    const order = [...host.children].map(el => el.tagName)
    expect(order).toEqual(['P', 'UL', 'P', 'UL', 'P'])
  })

  it('renders plain prose unchanged', () => {
    render(<MarkdownSummary>{'Just a sentence with no list at all.'}</MarkdownSummary>)
    expect(screen.getByText(/Just a sentence/)).toBeInTheDocument()
  })
  // Nested lists. Bill summaries use them for tiered requirements -- the case
  // that prompted this was a mail-ballot bill whose return-site minimums vary
  // by county population, listed as children of the site requirement.
  const NESTED = [
    'Amends the Nevada Constitution to:',
    '- **Mail Ballot Return Sites:** Require each county clerk to establish sites.',
    '  - **Clark County (700,000+):** At least 10 sites.',
    '  - **Washoe County (100,000-699,999):** At least 5 sites.',
    '  - **Rural counties (under 100,000):** At least 1 site.',
    '- **Additional Sites:** Allow clerks to establish more.',
  ].join('\n')

  it('nests indented items under their parent instead of flattening them', () => {
    const { container } = render(<MarkdownSummary>{NESTED}</MarkdownSummary>)
    // Two top-level items, not five.
    expect(topItems(container)).toHaveLength(2)
    const childList = container.querySelector('li ul')
    expect(childList).not.toBeNull()
    expect(childList!.querySelectorAll('li')).toHaveLength(3)
  })

  it('keeps the nested items in order under the right parent', () => {
    const { container } = render(<MarkdownSummary>{NESTED}</MarkdownSummary>)
    const top = topItems(container)
    expect(top[0].textContent).toContain('Mail Ballot Return Sites')
    const kids = [...top[0].querySelectorAll('ul > li')].map(li => li.textContent ?? '')
    expect(kids).toHaveLength(3)
    expect(kids[0]).toContain('Clark County')
    expect(kids[2]).toContain('Rural counties')
    // The second top-level item is a sibling, not a child of the first.
    expect(top[1].textContent).toContain('Additional Sites')
    expect(top[1].querySelectorAll('ul')).toHaveLength(0)
  })

  it('nests an ordered list inside a bulleted one', () => {
    const { container } = render(
      <MarkdownSummary>{'- Parent item\n  1. first\n  2. second'}</MarkdownSummary>
    )
    expect(topItems(container)).toHaveLength(1)
    expect(container.querySelectorAll('li ol > li')).toHaveLength(2)
  })

  it('clamps a depth jump instead of creating empty phantom lists', () => {
    const { container } = render(
      <MarkdownSummary>{'- Parent\n      - Deeply indented child'}</MarkdownSummary>
    )
    expect(topItems(container)).toHaveLength(1)
    expect(container.querySelectorAll('li ul > li')).toHaveLength(1)
    // No list that contains no items at all.
    const empties = [...container.querySelectorAll('ul, ol')].filter(l => l.querySelectorAll(':scope > li').length === 0)
    expect(empties).toHaveLength(0)
  })

  it('treats a tab as one level of indentation', () => {
    const { container } = render(<MarkdownSummary>{'- Parent\n\t- Child'}</MarkdownSummary>)
    expect(container.querySelectorAll('li ul > li')).toHaveLength(1)
  })

  it('returns to the parent level after a nested run', () => {
    const { container } = render(
      <MarkdownSummary>{'- A\n  - A1\n- B\n  - B1\n- C'}</MarkdownSummary>
    )
    expect(topItems(container)).toHaveLength(3)
    expect(container.querySelectorAll('li ul')).toHaveLength(2)
  })

})
