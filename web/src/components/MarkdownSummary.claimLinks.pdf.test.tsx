import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownSummary } from './MarkdownSummary'

// A PDF claim's link shows its quote beside it (#572): a tooltip that opens on
// hover and on keyboard focus, closes with Escape, and is the link's
// description for a screen reader. Invented summary text.

const SUMMARY = [
  'Sets rules for ballot drop boxes.',
  '- Requires a drop box in each county.',
  '- Boxes are emptied daily by two employees.',
].join('\n')

const QUOTE_ONE = 'Page 7: “Each county shall have a drop box.”'
const QUOTE_TWO = 'No page was cited, so the PDF opens at page 1: “Two employees empty each box.”'
const CLAIMS = [
  { index: 0, claim: 'Requires a drop box in each county.', popover: QUOTE_ONE },
  { index: 1, claim: 'Boxes are emptied daily by two employees.', popover: QUOTE_TWO },
]

const refOf = (name: string) => {
  const ref = screen.getByRole('link', { name }).closest('.claim-ref')
  expect(ref).not.toBeNull()
  return ref as HTMLElement
}

describe('MarkdownSummary: PDF claim links with a quote', () => {
  it('describes each link by its quote, for a screen reader', () => {
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>)
    expect(screen.getByRole('link', { name: 'Requires a drop box in each county.' })).toHaveAccessibleDescription(QUOTE_ONE)
    expect(screen.getByRole('link', { name: 'Boxes are emptied daily by two employees.' })).toHaveAccessibleDescription(QUOTE_TWO)
  })

  it('keeps the link\'s name the claim\'s text alone, without the quote', () => {
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>)
    expect(screen.getAllByRole('link').map(l => l.textContent)).toEqual(['Requires a drop box in each county.', 'Boxes are emptied daily by two employees.'])
  })

  it('puts the quote in the document beside the link, so it is there when the link has focus', () => {
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>)
    const ref = refOf('Requires a drop box in each county.')
    expect(ref.querySelector('.claim-quote')!.textContent).toBe(QUOTE_ONE)
  })

  it('is reachable by Tab, in order, one stop for each link and none for a quote', async () => {
    const user = userEvent.setup()
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>)
    await user.tab()
    expect(screen.getByRole('link', { name: 'Requires a drop box in each county.' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Boxes are emptied daily by two employees.' })).toHaveFocus()
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it('activates with Enter, and with a click, telling the page which claim', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={onClaimActivate}>{SUMMARY}</MarkdownSummary>)
    await user.tab()
    await user.keyboard('{Enter}')
    expect(onClaimActivate).toHaveBeenLastCalledWith(0)
    await user.click(screen.getByRole('link', { name: 'Boxes are emptied daily by two employees.' }))
    expect(onClaimActivate).toHaveBeenLastCalledWith(1)
  })

  it('does not treat a click on the quote itself as activating the claim', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={onClaimActivate}>{SUMMARY}</MarkdownSummary>)
    const tip = refOf('Requires a drop box in each county.').querySelector('.claim-quote')
    expect(tip).not.toBeNull()
    await user.click(tip!)
    expect(onClaimActivate).not.toHaveBeenCalled()
  })

  it('gives two summaries on one page different tooltip ids', () => {
    render(
      <>
        <MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>
        <MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>
      </>,
    )
    const ids = [...document.querySelectorAll('.claim-quote')].map(e => e.id)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
  })

  it('shows no quote, adds no quote style, and no wrapper, for claims without one (an HTML bill)', () => {
    const plain = [{ index: 0, claim: 'Requires a drop box in each county.' }]
    const { container } = render(<MarkdownSummary claimLinks={plain} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>)
    expect(container.querySelector('.claim-quote, .claim-ref')).toBeNull()
    expect(container.innerHTML).not.toContain('claim-quote')
    expect(screen.getByRole('link', { name: 'Requires a drop box in each county.' })).not.toHaveAttribute('aria-describedby')
  })

  it('renders exactly as before when no claim has a quote, and when no claims are given', () => {
    const before = render(<MarkdownSummary>{SUMMARY}</MarkdownSummary>).container.innerHTML
    const none = render(<MarkdownSummary claimLinks={[]} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>).container.innerHTML
    expect(none).toBe(before)
    expect(before).not.toContain('claim-ref')
  })

  // The restyle in #571 (Honey underline, hover wash, focus ring) is one rule on
  // `a.claim-link`, which a PDF claim's link carries too. The quote beside it
  // keeps its own look: a card with a border, not an underline or a wash.
  it('gives a PDF claim link the same look as an HTML one', () => {
    const { container } = render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>)
    expect(screen.getByRole('link', { name: 'Requires a drop box in each county.' })).toHaveClass('claim-link')
    const css = [...container.parentElement!.querySelectorAll('style')].map(el => el.textContent ?? '').join('\n')
    expect(css).toMatch(/\.markdown-summary a\.claim-link \{[^}]*text-decoration-color: var\(--fv-claim-underline-rest\)/)
    expect(css).toMatch(/a\.claim-link:hover,\s*\.markdown-summary a\.claim-link:focus-visible \{[^}]*background: var\(--fv-claim-hover-bg\)/)
  })
})
