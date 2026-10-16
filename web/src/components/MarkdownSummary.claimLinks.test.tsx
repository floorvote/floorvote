import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownSummary } from './MarkdownSummary'

// Claim links in the rendered summary (#571): the claim's own text is the link,
// and activating it asks the page to open the passage. Invented summary text.

const SUMMARY = [
  'Sets rules for ballot drop boxes, and boxes are emptied daily by two employees.',
  '- Requires a drop box in each county.',
  '- See [the rule](https://example.com/rule) for details.',
].join('\n')

const CLAIMS = [
  { index: 0, claim: 'Requires a drop box in each county.' },
  { index: 2, claim: 'boxes are emptied daily by two employees' },
]

describe('MarkdownSummary claim links', () => {
  it('renders exactly as before when it is given no claims', () => {
    const before = render(<MarkdownSummary>{SUMMARY}</MarkdownSummary>).container.innerHTML
    const none = render(<MarkdownSummary claimLinks={[]} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>).container.innerHTML
    expect(none).toBe(before)
    expect(before).not.toContain('data-claim')
    expect(before).not.toContain('claim-link')
  })

  it('makes each claim\'s own text a link, a list item or a clause', () => {
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>)
    expect(screen.getByRole('link', { name: 'Requires a drop box in each county.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'boxes are emptied daily by two employees' })).toBeInTheDocument()
    // The summary's own link is still there, and still the only other one.
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })

  it('tells the page which claim was clicked, and does not follow the link\'s href', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={onClaimActivate}>{SUMMARY}</MarkdownSummary>)
    const before = window.location.href
    await user.click(screen.getByRole('link', { name: 'boxes are emptied daily by two employees' }))
    expect(onClaimActivate).toHaveBeenCalledWith(2)
    expect(window.location.href).toBe(before)
  })

  it('is reachable from the keyboard, and Enter activates it', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={onClaimActivate}>{SUMMARY}</MarkdownSummary>)
    await user.tab()
    expect(screen.getByRole('link', { name: 'boxes are emptied daily by two employees' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('link', { name: 'Requires a drop box in each county.' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onClaimActivate).toHaveBeenCalledWith(0)
  })

  it('leaves the summary\'s own links alone', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={onClaimActivate}>{SUMMARY}</MarkdownSummary>)
    const own = screen.getByRole('link', { name: 'the rule' })
    own.addEventListener('click', e => e.preventDefault())
    await user.click(own)
    expect(onClaimActivate).not.toHaveBeenCalled()
  })

  it('renders a claim with markup in it as text', () => {
    const { container } = render(
      <MarkdownSummary claimLinks={[{ index: 0, claim: '<img src=x onerror=alert(1)>' }]} onClaimActivate={() => {}}>
        {'Bans &lt;img src=x onerror=alert(1)&gt; in filings.'}
      </MarkdownSummary>,
    )
    expect(screen.getByRole('link', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})
