import { describe, it, expect } from 'vitest'
import { linkableClaims, linkClaimsInHtml, type ClaimSourceItem, type ClaimSourcesDetail } from './claimLinks'

// Claim links on a PDF bill (#572): an `unverified` item links to its cited
// page, with the quote shown beside the link. The same link rules as HTML
// otherwise (#571). Fixtures are invented text, not bill text.

const PDF = { docId: '9102', type: 'Amended', date: '2026-01-02', mime: 'application/pdf', stateLink: null, altStateLink: null }
const HTML = { ...PDF, mime: 'text/html' }
const cs = (items: ClaimSourceItem[], document = PDF): ClaimSourcesDetail => ({ billId: 's200', document, items })
const unverified = (claim: string, quote: string, page?: number | null): ClaimSourceItem =>
  ({ claim, status: 'unverified', quote, ...(page === undefined ? {} : { page }) })

describe('linkableClaims on a PDF document', () => {
  it('links an unverified item with the quote and page it cites, and keeps its place in the list', () => {
    const items: ClaimSourceItem[] = [
      { claim: 'Skipped.', status: 'ungrounded' },
      unverified('Requires a drop box.', 'Each county shall have a drop box.', 7),
    ]
    expect(linkableClaims(cs(items), true)).toEqual([{
      index: 1, claim: 'Requires a drop box.', quote: 'Each county shall have a drop box.', page: 7,
      popover: 'Page 7: “Each county shall have a drop box.”',
    }])
  })

  it('links an item with no page, which will open at page 1, and says so beside the quote', () => {
    const [link] = linkableClaims(cs([unverified('Requires a drop box.', 'Each county.', null), unverified('Other.', 'Quote two.')]), true)
    expect(link).toMatchObject({ index: 0, quote: 'Each county.', page: null })
    expect((link as { popover: string }).popover).toBe('No page was cited, so the PDF opens at page 1: “Each county.”')
    const second = linkableClaims(cs([unverified('Requires a drop box.', 'Each county.', null), unverified('Other.', 'Quote two.')]), true)[1]
    expect(second).toMatchObject({ index: 1, page: null })
  })

  it('links an item with a zero or negative page, and says the page is not usable', () => {
    const out = linkableClaims(cs([unverified('One.', 'Quote one.', 0), unverified('Two.', 'Quote two.', -2)]), true) as { popover: string; page: number }[]
    expect(out).toHaveLength(2)
    expect(out[0].popover).toBe('The cited page isn’t usable, so the PDF opens at page 1: “Quote one.”')
    expect(out[1].popover).toContain('isn’t usable')
    expect(out.map(l => l.page)).toEqual([0, -2])
  })

  it('links a page past the end of the file as cited, which the viewer clamps', () => {
    const [link] = linkableClaims(cs([unverified('One.', 'Quote one.', 9999)]), true)
    expect(link).toMatchObject({ page: 9999, popover: 'Page 9999: “Quote one.”' })
  })

  it('does not link an ungrounded item', () => {
    expect(linkableClaims(cs([{ claim: 'One.', status: 'ungrounded' }]), true)).toEqual([])
  })

  it('does not link an unverified item whose quote is blank or missing', () => {
    expect(linkableClaims(cs([unverified('One.', '', 3), unverified('Two.', '   ', 3), { claim: 'Three.', status: 'unverified', page: 3 }]), true)).toEqual([])
  })

  it('does not link a resolved status on a PDF, since a PDF has no highlight to open', () => {
    const resolved = (status: ClaimSourceItem['status']): ClaimSourceItem => ({ claim: 'One.', status, quote: 'Q.', page: 2, quoteAt: { start: 0, end: 5 }, matched: 'Each.' })
    for (const s of ['exact', 'normalized', 'fuzzy', 'anchored'] as const) {
      expect(linkableClaims(cs([resolved(s)]), true)).toEqual([])
    }
  })

  it('links nothing with the instance setting off', () => {
    expect(linkableClaims(cs([unverified('One.', 'Quote.', 3)]), false)).toEqual([])
  })

  it('links nothing without claim sources', () => {
    expect(linkableClaims(null, true)).toEqual([])
    expect(linkableClaims(undefined, true)).toEqual([])
  })
})

describe('linkableClaims: an unverified item on an HTML document', () => {
  it('stays plain text, as in #571', () => {
    expect(linkableClaims(cs([unverified('One.', 'Quote.', 3)], HTML), true)).toEqual([])
  })
})

// The summary HTML MarkdownSummary renders, which the claims are linked in.
function parse(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}
const claim = (index: number, text: string, popover?: string) => ({ index, claim: text, ...(popover === undefined ? {} : { popover }) })

describe('linkClaimsInHtml: a claim with a popover', () => {
  const HTML_IN = '<ul><li>Requires a drop box in each county.</li><li>Other.</li></ul>'

  it('puts the quote in a tooltip beside the link, and describes the link by it', () => {
    const out = linkClaimsInHtml(HTML_IN, [claim(0, 'Requires a drop box in each county.', 'Page 7: “Each county.”')], 'q')
    const ref = parse(out).querySelector('li .claim-ref')!
    expect(ref).not.toBeNull()
    const a = ref.querySelector('a.claim-link') as HTMLAnchorElement
    const tip = ref.querySelector('.claim-quote') as HTMLElement
    expect(a.textContent).toBe('Requires a drop box in each county.')
    expect(a.dataset.claim).toBe('0')
    expect(tip.textContent).toBe('Page 7: “Each county.”')
    expect(tip.getAttribute('role')).toBe('tooltip')
    expect(tip.id).toBeTruthy()
    expect(a.getAttribute('aria-describedby')).toBe(tip.id)
    // The tooltip sits beside the link, not inside it.
    expect(a.contains(tip)).toBe(false)
    expect(tip.parentElement).toBe(ref)
  })

  it('gives each claim its own tooltip id, from the prefix and the claim\'s index', () => {
    const out = linkClaimsInHtml('<ul><li>One thing.</li><li>Two things.</li></ul>', [claim(0, 'One thing.', 'Page 1: “A.”'), claim(5, 'Two things.', 'Page 2: “B.”')], 'pfx')
    const ids = [...parse(out).querySelectorAll('.claim-quote')].map(e => e.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every(id => id.startsWith('pfx'))).toBe(true)
  })

  it('sets the quote as text only: a quote with markup or an attribute break-out adds no element', () => {
    const quote = '“<img src=x onerror="alert(1)"><script>alert(2)</script>" onclick="x"'
    const out = linkClaimsInHtml(HTML_IN, [claim(0, 'Requires a drop box in each county.', quote)], 'q')
    const root = parse(out)
    expect(root.querySelector('img, script')).toBeNull()
    expect(root.querySelector('.claim-quote')).not.toBeNull()
    expect(root.querySelector('.claim-quote')!.textContent).toBe(quote)
    expect(root.querySelectorAll('[onclick], [onerror]')).toHaveLength(0)
    // The only elements added are the wrapper, the link, and the tooltip.
    expect(root.querySelectorAll('li:first-child *')).toHaveLength(3)
  })

  it('does not let a later claim link inside an earlier claim\'s quote', () => {
    const html = '<ul><li>Requires a drop box in each county.</li></ul><p>Each county shall have a drop box.</p>'
    const out = linkClaimsInHtml(html, [
      claim(0, 'Requires a drop box in each county.', 'Page 3: “Each county shall have a drop box.”'),
      { index: 1, claim: 'Each county shall have a drop box.' },
    ], 'q')
    const root = parse(out)
    expect(root.querySelector('.claim-quote a')).toBeNull()
    // The second claim links in the paragraph, where it is.
    expect(root.querySelector('p a.claim-link')!.textContent).toBe('Each county shall have a drop box.')
  })

  it('still finds a claim that sits after another claim\'s link in the same sentence', () => {
    const html = '<p>Requires a drop box, and boxes are emptied daily.</p>'
    const out = linkClaimsInHtml(html, [claim(0, 'Requires a drop box', 'Page 1: “X.”'), claim(1, 'boxes are emptied daily', 'Page 2: “Y.”')], 'q')
    const root = parse(out)
    expect([...root.querySelectorAll('a.claim-link')].map(a => a.textContent)).toEqual(['Requires a drop box', 'boxes are emptied daily'])
    expect(root.querySelector('p')!.textContent.replace(/Page \d: “[XY]\.”/g, '')).toBe('Requires a drop box, and boxes are emptied daily.')
  })

  it('leaves a claim with no popover as the plain link of #571, with no wrapper and no description', () => {
    const out = linkClaimsInHtml(HTML_IN, [claim(0, 'Requires a drop box in each county.')], 'q')
    const root = parse(out)
    expect(root.querySelector('.claim-ref, .claim-quote')).toBeNull()
    expect(root.querySelector('a.claim-link')!.hasAttribute('aria-describedby')).toBe(false)
    expect(out).toBe(linkClaimsInHtml(HTML_IN, [claim(0, 'Requires a drop box in each county.')]))
  })

  it('leaves the HTML as it was when the claim is not found, popover or not', () => {
    expect(linkClaimsInHtml(HTML_IN, [claim(0, 'Not in the summary.', 'Page 1: “X.”')], 'q')).toBe(HTML_IN)
  })

  it('does not wrap a claim that is inside a link the summary already has', () => {
    const html = '<p>See <a href="https://example.com">the county drop box rule</a> for more.</p>'
    expect(linkClaimsInHtml(html, [claim(0, 'the county drop box rule', 'Page 1: “X.”')], 'q')).toBe(html)
  })
})
