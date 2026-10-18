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

  it('ignores a link in the summary that carries data-claim but isn\'t one of the page\'s claim links', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    const { container } = render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={onClaimActivate}>{SUMMARY}</MarkdownSummary>)
    // As if a summary's own link had kept a data-claim attribute through sanitizing.
    const forged = document.createElement('a')
    forged.setAttribute('href', 'https://example.com/forged')
    forged.setAttribute('data-claim', '0')
    forged.textContent = 'Forged link'
    forged.addEventListener('click', e => e.preventDefault())
    container.querySelector('.markdown-summary')!.appendChild(forged)
    await user.click(screen.getByRole('link', { name: 'Forged link' }))
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

  // The look of a claim link (#571, restyled): Honey underline at rest, a faint
  // Honey wash on hover, the app's focus ring plus the wash on keyboard focus.
  // jsdom doesn't cascade, so these read the rules the component writes.
  describe('claim link style', () => {
    const rules = (container: HTMLElement) => {
      const css = [...container.parentElement!.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n')
      const out = new Map<string, string>()
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.set(m[1].trim().replace(/\s+/g, ' '), m[2].replace(/\s+/g, ' ').trim())
      return out
    }
    const styled = () => rules(render(<MarkdownSummary claimLinks={CLAIMS} onClaimActivate={() => {}}>{SUMMARY}</MarkdownSummary>).container)

    it('underlines at rest in reduced Honey, 1px thick, 3px off the text, keeping the text color (#696)', () => {
      const rest = styled().get('.markdown-summary a.claim-link') ?? ''
      expect(rest).toMatch(/color:\s*inherit/)
      expect(rest).toMatch(/text-decoration-line:\s*underline|text-decoration:\s*underline/)
      expect(rest).toContain('text-decoration-color: var(--fv-claim-underline-rest)')
      expect(rest).toContain('text-decoration-thickness: 1px')
      expect(rest).toContain('text-underline-offset: 3px')
      expect(rest).toMatch(/border-radius:\s*\d+px/)
    })

    it('no longer uses the light gray underline', () => {
      expect(styled().get('.markdown-summary a.claim-link')).not.toContain('--fv-border-strong')
    })

    it('goes to full Honey, 2px, with the faint wash on hover and focus, and leaves the text color alone', () => {
      const hover = styled().get('.markdown-summary a.claim-link:hover, .markdown-summary a.claim-link:focus-visible') ?? ''
      expect(hover).toContain('background: var(--fv-claim-hover-bg)')
      expect(hover).toContain('text-decoration-thickness: 2px')
      expect(hover).toContain('text-decoration-color: var(--fv-claim-underline)')
      expect(hover).not.toMatch(/(^|[;\s])color:/)
      expect(hover).not.toContain('--fv-link-blue')
      expect(hover).not.toContain('currentColor')
    })

    it('shows the app focus ring and the same wash on keyboard focus', () => {
      const focus = styled().get('.markdown-summary a.claim-link:focus-visible') ?? ''
      expect(focus).toContain('outline: 2px solid var(--fv-focus-ring)')
      expect(focus).toContain('outline-offset: 2px')
    })

    it('writes no color literals, so the look follows the color mode', () => {
      const all = [...styled().entries()].filter(([sel]) => sel.includes('claim-link')).map(([, body]) => body).join(' ')
      expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    })

    it('writes the claim link rules only when a claim is linked', () => {
      const { container } = render(<MarkdownSummary>{SUMMARY}</MarkdownSummary>)
      expect([...rules(container).keys()].some(sel => sel.includes('claim-link'))).toBe(false)
    })
  })
})
