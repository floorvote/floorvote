import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarkdownSummary } from './MarkdownSummary'

// Claim links, quieter and previewed (#696). A linked claim is a thin Honey
// underline at rest, thickening on hover and focus. Every claim with a quote
// previews it on hover and keyboard focus, HTML claims and PDF claims alike, in
// a glowing card portaled to the body so the summary box can't clip it.
// Invented summary text. jsdom doesn't cascade, so the style tests read the
// rules the component writes.

const SUMMARY = [
  'Sets rules for ballot drop boxes.',
  '- Requires a drop box in each county.',
  '- Boxes are emptied daily by two employees.',
  '- Boxes are checked for damage weekly.',
].join('\n')

const HTML_QUOTE = '“Each county shall have a drop box.”'
const PDF_QUOTE = 'Page 7: “Two employees empty each box.”'
const LONG = `“${'The board shall review every drop box location and report each finding. '.repeat(12).trim()}”`
const CLAIMS = [
  { index: 0, claim: 'Requires a drop box in each county.', popover: HTML_QUOTE },
  { index: 1, claim: 'Boxes are emptied daily by two employees.', popover: PDF_QUOTE },
  { index: 2, claim: 'Boxes are checked for damage weekly.' },
]
const LONG_CLAIMS = [{ index: 0, claim: 'Requires a drop box in each county.', popover: LONG }]

const ONE = 'Requires a drop box in each county.'
const TWO = 'Boxes are emptied daily by two employees.'
const THREE = 'Boxes are checked for damage weekly.'

// The test setup's matchMedia reports no match for anything, so a device that can hover is stubbed in.
const stubHover = (canHover: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
  matches: canHover && query === '(hover: hover)', media: query, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
}))
beforeEach(() => stubHover(true))
afterEach(() => { vi.unstubAllGlobals() })

const renderSummary = (claims = CLAIMS, onClaimActivate: (i: number) => void = () => {}) =>
  render(<MarkdownSummary claimLinks={claims} onClaimActivate={onClaimActivate}>{SUMMARY}</MarkdownSummary>)
const preview = () => document.body.querySelector('[data-claim-preview]') as HTMLElement | null
const linkNamed = (name: string) => screen.getByRole('link', { name })

describe('MarkdownSummary: the quieter claim link style', () => {
  const rules = (container: HTMLElement) => {
    const css = [...container.parentElement!.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n')
    const out = new Map<string, string>()
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.set(m[1].trim().replace(/\s+/g, ' '), m[2].replace(/\s+/g, ' ').trim())
    return out
  }
  const styled = () => rules(renderSummary().container)

  it('underlines at rest with a 1px line in the reduced Honey token, 3px off the text', () => {
    const rest = styled().get('.markdown-summary a.claim-link') ?? ''
    expect(rest).toContain('text-decoration-thickness: 1px')
    expect(rest).toContain('text-decoration-color: var(--fv-claim-underline-rest)')
    expect(rest).toContain('text-underline-offset: 3px')
    expect(rest).toMatch(/color:\s*inherit/)
  })

  it('thickens to 2px of full Honey with the wash on hover', () => {
    const hover = styled().get('.markdown-summary a.claim-link:hover, .markdown-summary a.claim-link:focus-visible') ?? ''
    expect(hover).toContain('text-decoration-thickness: 2px')
    expect(hover).toContain('text-decoration-color: var(--fv-claim-underline)')
    expect(hover).toContain('background: var(--fv-claim-hover-bg)')
  })

  it('keeps a clear focus ring on keyboard focus', () => {
    const focus = styled().get('.markdown-summary a.claim-link:focus-visible') ?? ''
    expect(focus).toContain('outline: 2px solid var(--fv-focus-ring)')
    expect(focus).toContain('outline-offset: 2px')
  })

  it('writes no color literals, so light and dark mode both apply', () => {
    const all = [...styled().entries()].filter(([sel]) => sel.includes('claim-link')).map(([, body]) => body).join(' ')
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|color-mix/)
  })

  it('still animates nothing under reduced motion: the underline transition is off', () => {
    const css = [...renderSummary().container.parentElement!.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*a\.claim-link[^}]*transition:\s*none/)
  })
})

describe('MarkdownSummary: the quote preview', () => {
  it('shows an HTML claim\'s quote on hover, and takes it away when the pointer leaves', async () => {
    const user = userEvent.setup()
    renderSummary()
    expect(preview()).toBeNull()
    await user.hover(linkNamed(ONE))
    expect(preview()).not.toBeNull()
    expect(preview()!.textContent).toContain(HTML_QUOTE)
    await user.unhover(linkNamed(ONE))
    expect(preview()).toBeNull()
  })

  it('shows a PDF claim\'s page line and quote on hover the same way', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(TWO))
    expect(preview()!.textContent).toContain(PDF_QUOTE)
  })

  it('shows the quote on keyboard focus, and takes it away on blur', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.tab()
    expect(linkNamed(ONE)).toHaveFocus()
    expect(preview()!.textContent).toContain(HTML_QUOTE)
    await user.tab()
    expect(linkNamed(TWO)).toHaveFocus()
    expect(preview()!.textContent).toContain(PDF_QUOTE)
    expect(preview()!.textContent).not.toContain(HTML_QUOTE)
    await user.tab()
    await user.tab()
    expect(preview()).toBeNull()
  })

  it('shows nothing on hover where the device can\'t hover, so iOS opens a claim on the first tap, and still shows it on focus', async () => {
    stubHover(false)
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    expect(preview()).toBeNull()
    await user.unhover(linkNamed(ONE))
    await user.tab()
    expect(preview()!.textContent).toContain(HTML_QUOTE)
  })

  it('shows only one preview at a time, for the claim the pointer is on', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    await user.hover(linkNamed(TWO))
    expect(document.body.querySelectorAll('[data-claim-preview]')).toHaveLength(1)
    expect(preview()!.textContent).toContain(PDF_QUOTE)
  })

  it('shows nothing for a claim with no quote', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(THREE))
    expect(preview()).toBeNull()
    await user.tab(); await user.tab(); await user.tab()
    expect(linkNamed(THREE)).toHaveFocus()
    expect(preview()).toBeNull()
  })

  it('renders the preview in the body, outside the summary box, so no ancestor can clip it', async () => {
    const user = userEvent.setup()
    const { container } = renderSummary()
    await user.hover(linkNamed(ONE))
    const p = preview()!
    expect(p.parentElement).toBe(document.body)
    expect(container.contains(p)).toBe(false)
    expect(p.style.position).toBe('fixed')
  })

  it('leaves the quote a screen reader gets as the link\'s description, and hides the visual copy from it', async () => {
    const user = userEvent.setup()
    renderSummary()
    expect(linkNamed(ONE)).toHaveAccessibleDescription(HTML_QUOTE)
    expect(linkNamed(TWO)).toHaveAccessibleDescription(PDF_QUOTE)
    await user.hover(linkNamed(ONE))
    expect(preview()).toHaveAttribute('aria-hidden', 'true')
    // Still read once, as the description, with the preview open.
    expect(linkNamed(ONE)).toHaveAccessibleDescription(HTML_QUOTE)
    expect(linkNamed(ONE).textContent).toBe(ONE)
  })

  it('keeps the quote in the document beside each link, hidden from sight and never shown inline', () => {
    const { container } = renderSummary()
    const tip = linkNamed(ONE).closest('.claim-ref')!.querySelector('.claim-quote') as HTMLElement
    expect(tip.textContent).toBe(HTML_QUOTE)
    const css = [...container.parentElement!.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n')
    const rule = css.match(/\.markdown-summary \.claim-quote \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/clip(-path)?:/)
    expect(css).not.toMatch(/:hover\s*>\s*\.claim-quote/)
    expect(css).not.toMatch(/:focus-within\s*>\s*\.claim-quote/)
  })

  it('is reachable by Tab as before: one stop for each link, none for a quote or a preview', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.tab(); await user.tab(); await user.tab()
    expect(linkNamed(THREE)).toHaveFocus()
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it('wears the glow: a Honey border, halo and blur from the glow tokens', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    const p = preview()!
    expect(p.style.border).toContain('var(--fv-claim-glow-border)')
    expect(p.style.boxShadow).toContain('var(--fv-claim-glow-halo)')
    expect(p.style.boxShadow).toContain('var(--fv-claim-glow-blur)')
    expect(p.style.background).toContain('var(--fv-white)')
  })

  it('writes no color literal on the preview, so it follows the color mode', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    const p = preview()!
    expect(p.getAttribute('style')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\((?!0,0,0)/)
  })

  it('shows a long quote in full to a screen reader, and clamps it on screen', async () => {
    const user = userEvent.setup()
    renderSummary(LONG_CLAIMS)
    expect(linkNamed(ONE)).toHaveAccessibleDescription(LONG)
    await user.hover(linkNamed(ONE))
    const body = preview()!.querySelector('[data-claim-preview-text]') as HTMLElement
    expect(body.textContent).toBe(LONG)
    expect(body.style.overflow).toBe('hidden')
    expect(body.style.getPropertyValue('-webkit-line-clamp')).toMatch(/^\d+$/)
    expect(preview()!.style.maxWidth).toContain('26rem')
  })

  it('keeps a preview inside the viewport: it is placed in measured pixels, clear of the left edge', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    const p = preview()!
    expect(p.style.visibility).toBe('visible')
    expect(parseFloat(p.style.left)).toBeGreaterThanOrEqual(8)
    expect(parseFloat(p.style.top)).toBeGreaterThanOrEqual(8)
  })

  it('does not capture the pointer, so moving onto it never traps or flickers the claim', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    expect(preview()!.style.pointerEvents).toBe('none')
  })

  it('gives the preview a "from the bill text" label above the quote', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    expect(preview()!.textContent).toMatch(/^From the bill text/)
  })
})

describe('MarkdownSummary: dismissing a preview with Escape (WCAG 1.4.13)', () => {
  it('closes the preview on Escape while the link has focus, and shows it again on the next focus', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.tab()
    expect(preview()).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(preview()).toBeNull()
    expect(linkNamed(ONE)).toHaveFocus()
    await user.tab()
    expect(linkNamed(TWO)).toHaveFocus()
    expect(preview()!.textContent).toContain(PDF_QUOTE)
    await user.tab()
    await user.tab()
    expect(document.body).toHaveFocus()
    expect(preview()).toBeNull()
    await user.tab()
    expect(linkNamed(ONE)).toHaveFocus()
    expect(preview()!.textContent).toContain(HTML_QUOTE)
  })

  it('closes the preview on Escape while the pointer is over the claim, and shows it again when the pointer returns', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    expect(preview()).not.toBeNull()
    fireEvent.keyDown(linkNamed(ONE), { key: 'Escape' })
    expect(preview()).toBeNull()
    // Still over it: moving within the claim does not bring it back.
    fireEvent.mouseOver(linkNamed(ONE))
    expect(preview()).toBeNull()
    await user.unhover(linkNamed(ONE))
    await user.hover(linkNamed(ONE))
    expect(preview()).not.toBeNull()
  })

  it('ignores Escape when no preview is open', () => {
    renderSummary()
    expect(() => fireEvent.keyDown(document.body, { key: 'Escape' })).not.toThrow()
    expect(preview()).toBeNull()
  })

  it('does not stop Escape from reaching anything else when no preview is open', () => {
    renderSummary()
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    document.removeEventListener('keydown', seen)
    expect(seen).toHaveBeenCalled()
  })
})

describe('MarkdownSummary: previews and activation together', () => {
  it('still tells the page which claim was clicked, and passes the link element for focus to return to', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    renderSummary(CLAIMS, onClaimActivate)
    await user.click(linkNamed(TWO))
    expect(onClaimActivate).toHaveBeenCalledTimes(1)
    expect(onClaimActivate.mock.calls[0][0]).toBe(1)
    expect(onClaimActivate.mock.calls[0][1]).toBe(linkNamed(TWO))
  })

  it('activates with Enter on a focused claim whose preview is showing', async () => {
    const onClaimActivate = vi.fn()
    const user = userEvent.setup()
    renderSummary(CLAIMS, onClaimActivate)
    await user.tab()
    expect(preview()).not.toBeNull()
    await user.keyboard('{Enter}')
    expect(onClaimActivate.mock.calls[0][0]).toBe(0)
  })

  it('removes the preview when the summary goes away', async () => {
    const user = userEvent.setup()
    const { unmount } = renderSummary()
    await user.hover(linkNamed(ONE))
    expect(preview()).not.toBeNull()
    unmount()
    expect(preview()).toBeNull()
  })

  it('hides the preview when the page scrolls the claim, rather than leaving it floating', async () => {
    const user = userEvent.setup()
    renderSummary()
    await user.hover(linkNamed(ONE))
    expect(preview()).not.toBeNull()
    act(() => { window.dispatchEvent(new Event('scroll')) })
    expect(preview()).toBeNull()
  })
})
