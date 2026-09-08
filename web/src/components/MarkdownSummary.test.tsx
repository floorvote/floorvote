import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarkdownSummary } from './MarkdownSummary'

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
    const order = [...container.children[0].children].map(el => el.tagName)
    expect(order).toEqual(['P', 'UL', 'P', 'UL', 'P'])
  })

  it('renders plain prose unchanged', () => {
    render(<MarkdownSummary>{'Just a sentence with no list at all.'}</MarkdownSummary>)
    expect(screen.getByText(/Just a sentence/)).toBeInTheDocument()
  })
})
