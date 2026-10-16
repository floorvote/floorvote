import { describe, it, expect } from 'vitest'
import { billHtmlToText } from '../../../shared/billHtmlToText'
import { linkableClaims, linkClaimsInHtml, markPassage, PASSAGE_ID, type ClaimSourcesDetail, type ClaimSourceItem } from './claimLinks'

// Claim links on HTML bills (#571). Fixtures are invented text, not bill text.

const DOC = { docId: '9002', type: 'Introduced', date: '2026-01-02', mime: 'text/html', stateLink: null, altStateLink: null }
const at = (start: number, end: number) => ({ start, end })
const cs = (items: ClaimSourceItem[], document = DOC): ClaimSourcesDetail => ({ billId: 's200', document, items })
const resolved = (claim: string, status: ClaimSourceItem['status']): ClaimSourceItem =>
  ({ claim, status, quoteAt: at(0, 5), matched: 'Each.' })

describe('linkableClaims', () => {
  it('links exact, normalized, fuzzy, and anchored claims, and keeps each one\'s place in the list', () => {
    const items = [
      resolved('One.', 'exact'), resolved('Two.', 'normalized'), resolved('Three.', 'fuzzy'),
      resolved('Four.', 'anchored'), { claim: 'Five.', status: 'ungrounded' as const }, resolved('Six.', 'unverified'),
    ]
    expect(linkableClaims(cs(items), true).map(c => [c.index, c.claim])).toEqual([[0, 'One.'], [1, 'Two.'], [2, 'Three.'], [3, 'Four.']])
  })

  it('carries the passage each link opens', () => {
    expect(linkableClaims(cs([{ claim: 'One.', status: 'exact', quoteAt: at(3, 9), matched: 'Each c' }]), true))
      .toEqual([{ index: 0, claim: 'One.', quoteAt: at(3, 9), matched: 'Each c' }])
  })

  it('links nothing with the instance setting off', () => {
    expect(linkableClaims(cs([resolved('One.', 'exact')]), false)).toEqual([])
  })

  it('links nothing when there are no claim sources', () => {
    expect(linkableClaims(null, true)).toEqual([])
    expect(linkableClaims(undefined, true)).toEqual([])
  })

  it('links nothing on a PDF document, which links by page instead (#572)', () => {
    expect(linkableClaims(cs([resolved('One.', 'exact')], { ...DOC, mime: 'application/pdf' }), true)).toEqual([])
  })

  it('does not link a resolved item without a location or a passage', () => {
    expect(linkableClaims(cs([
      { claim: 'One.', status: 'exact' },
      { claim: 'Two.', status: 'exact', quoteAt: at(0, 3) },
      { claim: 'Three.', status: 'exact', quoteAt: at(0, 3), matched: '' },
    ]), true)).toEqual([])
  })
})

// The summary HTML MarkdownSummary renders (marked, then sanitized), which the claims are linked in.
function parse(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}
const links = (html: string) => [...parse(html).querySelectorAll('a[data-claim]')] as HTMLAnchorElement[]
const firstLink = (html: string) => {
  const found = links(html)
  expect(found.length).toBeGreaterThan(0)
  return found[0]
}

describe('linkClaimsInHtml', () => {
  it('makes a whole list item the link', () => {
    const out = linkClaimsInHtml('<ul><li>Requires a drop box in each county.</li><li>Other.</li></ul>', [{ index: 0, claim: 'Requires a drop box in each county.' }])
    const a = firstLink(out)
    expect(a.textContent).toBe('Requires a drop box in each county.')
    expect(a.dataset.claim).toBe('0')
    expect(a.closest('li')!.textContent).toBe('Requires a drop box in each county.')
    expect(parse(out).querySelectorAll('li')[1].textContent).toBe('Other.')
  })

  it('makes a clause inside a sentence the link, and leaves the rest of the sentence as text', () => {
    const out = linkClaimsInHtml('<p>Requires a drop box, and boxes are emptied daily by two employees.</p>', [{ index: 3, claim: 'boxes are emptied daily by two employees' }])
    const a = firstLink(out)
    expect(a.textContent).toBe('boxes are emptied daily by two employees')
    expect(a.dataset.claim).toBe('3')
    expect(parse(out).querySelector('p')!.textContent).toBe('Requires a drop box, and boxes are emptied daily by two employees.')
  })

  it('links a list item copied with its markdown emphasis', () => {
    const out = linkClaimsInHtml('<ul><li><strong>Daily Reporting:</strong> clerks post totals by 11 a.m.</li></ul>', [{ index: 0, claim: '**Daily Reporting:** clerks post totals by 11 a.m.' }])
    expect(links(out)).toHaveLength(1)
    expect(firstLink(out).textContent).toBe('Daily Reporting: clerks post totals by 11 a.m.')
    expect(firstLink(out).querySelector('strong')!.textContent).toBe('Daily Reporting:')
  })

  it('finds a claim whose whitespace differs from the rendered text', () => {
    const out = linkClaimsInHtml('<p>Requires a drop box in each county.</p>', [{ index: 0, claim: 'Requires  a drop\nbox in each county.' }])
    expect(firstLink(out).textContent).toBe('Requires a drop box in each county.')
  })

  it('leaves the HTML exactly as it was when there are no claims, or none is found', () => {
    const html = '<p>Requires a <em>drop box</em> in each county.</p><ul><li>One &amp; two.</li></ul>'
    expect(linkClaimsInHtml(html, [])).toBe(html)
    expect(linkClaimsInHtml(html, [{ index: 0, claim: 'Not in the summary.' }])).toBe(html)
  })

  it('does not link a claim across two list items', () => {
    const html = '<ul><li>Requires a drop box.</li><li>Boxes are emptied daily.</li></ul>'
    expect(linkClaimsInHtml(html, [{ index: 0, claim: 'Requires a drop box. Boxes are emptied daily.' }])).toBe(html)
  })

  it('does not link a claim inside a link the summary already has, so links never nest', () => {
    const html = '<p>See <a href="https://example.com">the county drop box rule</a> for more.</p>'
    expect(linkClaimsInHtml(html, [{ index: 0, claim: 'the county drop box rule' }])).toBe(html)
  })

  it('links the first of two overlapping claims and not the second, so links never nest', () => {
    const out = linkClaimsInHtml('<p>Requires a drop box in each county.</p>', [
      { index: 0, claim: 'Requires a drop box in each county.' },
      { index: 1, claim: 'a drop box' },
    ])
    expect(links(out).map(a => a.dataset.claim)).toEqual(['0'])
    expect(parse(out).querySelectorAll('a a')).toHaveLength(0)
  })

  it('treats a claim as text: markup in it is matched as characters and never becomes markup', () => {
    const html = '<p>Bans the tag &lt;img src=x onerror=alert(1)&gt; in filings.</p>'
    const out = linkClaimsInHtml(html, [{ index: 0, claim: '<img src=x onerror=alert(1)>' }])
    expect(parse(out).querySelector('img')).toBeNull()
    expect(firstLink(out).textContent).toBe('<img src=x onerror=alert(1)>')
    // Not found: nothing changes.
    expect(linkClaimsInHtml('<p>Plain.</p>', [{ index: 0, claim: '"><script>alert(1)</script>' }])).toBe('<p>Plain.</p>')
  })

  it('gives each link only its own fixed attributes, nothing taken from the claim', () => {
    const a = firstLink(linkClaimsInHtml('<p>Requires " onclick="x a box.</p>', [{ index: 7, claim: 'Requires " onclick="x a box.' }]))
    expect(a.getAttributeNames().sort()).toEqual(['class', 'data-claim', 'href'])
    expect(a.getAttribute('href')).toBe(`#${PASSAGE_ID}`)
    expect(a.dataset.claim).toBe('7')
  })
})

// A bill document as legislatures publish it, with the offsets the instance
// stored: into billHtmlToText(document), the text the model read.
function passageIn(html: string, text: string, nth = 0) {
  const t = billHtmlToText(html)
  let start = -1
  for (let i = 0; i <= nth; i++) start = t.indexOf(text, start + 1)
  if (start === -1) throw new Error(`fixture: ${text} not in ${t}`)
  return { quoteAt: at(start, start + text.length), matched: text }
}
const parseDoc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const marksOf = (doc: Document) => [...doc.querySelectorAll('mark[data-fv-passage]')]
const markedText = (doc: Document) => marksOf(doc).map(m => m.textContent).join('')

describe('markPassage', () => {
  const BILL = '<!DOCTYPE html><html><head><title>A100</title></head><body><p>Section 1.</p><p>Each <span>county</span> shall have a drop box.</p><p>Section 2.</p></body></html>'

  it('wraps the passage in a highlight, across the document\'s own inline markup, and gives the first part the id the frame scrolls to', () => {
    const out = markPassage(BILL, passageIn(BILL, 'Each county shall have a drop box.'))!
    const doc = parseDoc(out)
    expect(markedText(doc).replace(/\s+/g, ' ')).toBe('Each county shall have a drop box.')
    expect(doc.querySelectorAll(`#${PASSAGE_ID}`)).toHaveLength(1)
    expect(doc.getElementById(PASSAGE_ID)).toBe(marksOf(doc)[0])
    expect(doc.querySelector('span')!.textContent).toBe('county')
  })

  it('keeps the document otherwise as it was', () => {
    const doc = parseDoc(markPassage(BILL, passageIn(BILL, 'Each county shall have a drop box.'))!)
    expect(doc.body.textContent).toBe(parseDoc(BILL).body.textContent)
    expect(doc.title).toBe('A100')
    expect([...doc.body.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Section 1.', 'Each county shall have a drop box.', 'Section 2.'])
  })

  it('styles the highlight from the document head', () => {
    const doc = parseDoc(markPassage(BILL, passageIn(BILL, 'Section 2.'))!)
    const style = doc.head.querySelector('style[data-fv-passage]')
    expect(style).not.toBeNull()
    expect(style!.textContent).toContain('mark[data-fv-passage]')
  })

  it('finds a passage through retained redline markup, line breaks, and non-breaking spaces', () => {
    const html = '<html><body><p>Each county <strike>may</strike> <u>shall</u>\n have&nbsp;a\n drop box.</p></body></html>'
    // As #569 stores it: the passage without the retained markup, whitespace collapsed.
    const t = billHtmlToText(html)
    const start = t.indexOf('Each')
    const out = markPassage(html, { quoteAt: at(start, t.length), matched: 'Each county may shall have a drop box.' })!
    expect(markedText(parseDoc(out)).replace(/\s+/g, ' ')).toBe('Each county may shall have a drop box.')
  })

  it('finds a passage with an entity the instance\'s text leaves encoded', () => {
    const html = '<html><body><p>Amends &sect; 12 of the code.</p></body></html>'
    const out = markPassage(html, passageIn(html, 'Amends &sect; 12'))!
    expect(markedText(parseDoc(out))).toBe('Amends § 12')
  })

  it('marks the second of two identical passages when that is where the stored location is', () => {
    const html = '<html><body><p>Each county shall have a drop box.</p><p>Section 9.</p><p>Each county shall have a drop box.</p></body></html>'
    const doc = parseDoc(markPassage(html, passageIn(html, 'Each county shall have a drop box.', 1))!)
    const ps = doc.body.querySelectorAll('p')
    expect(ps).toHaveLength(3)
    expect(ps[0].querySelector('mark')).toBeNull()
    expect(ps[2].querySelector('mark')).not.toBeNull()
  })

  it('marks the first of two identical passages when that is where the stored location is', () => {
    const html = '<html><body><p>Each county shall have a drop box.</p><p>Each county shall have a drop box.</p></body></html>'
    const doc = parseDoc(markPassage(html, passageIn(html, 'Each county shall have a drop box.', 0))!)
    const ps = doc.body.querySelectorAll('p')
    expect(ps).toHaveLength(2)
    expect(ps[0].querySelector('mark')).not.toBeNull()
    expect(ps[1].querySelector('mark')).toBeNull()
  })

  it('is null when the passage is not in the document, or is empty', () => {
    expect(markPassage(BILL, { quoteAt: at(0, 10), matched: 'Not in this document at all.' })).toBeNull()
    expect(markPassage(BILL, { quoteAt: at(0, 0), matched: '' })).toBeNull()
    expect(markPassage(BILL, { quoteAt: at(0, 0), matched: '   ' })).toBeNull()
  })

  it('takes a location that is out of range or malformed without throwing, and falls back to the first match', () => {
    for (const quoteAt of [at(-5, -1), at(1e9, 1e9 + 5), at(30, 2), { start: Number.NaN, end: Number.NaN }, { start: 1.5, end: 3 }]) {
      const out = markPassage(BILL, { quoteAt, matched: 'Section 2.' })
      expect(out).not.toBeNull()
      expect(markedText(parseDoc(out!))).toBe('Section 2.')
    }
  })

  it('treats the passage as text: markup in it is matched as characters and never becomes markup', () => {
    const html = '<html><body><p>Bans &lt;img src=x onerror="alert(1)"&gt; in filings.</p></body></html>'
    const out = markPassage(html, { quoteAt: at(0, 0), matched: '<img src=x onerror="alert(1)">' })!
    const doc = parseDoc(out)
    expect(doc.querySelector('img')).toBeNull()
    expect(markedText(doc)).toBe('<img src=x onerror="alert(1)">')
    // Nothing is added but the highlights and their style.
    const tags = (d: Document) => [...d.querySelectorAll('*')].map(e => e.tagName.toLowerCase()).filter(t => t !== 'mark' && t !== 'style').sort()
    expect(tags(doc)).toEqual(tags(parseDoc(html)))
    expect(markPassage(html, { quoteAt: at(0, 0), matched: '</mark><script>alert(1)</script>' })).toBeNull()
  })

  it('takes the scroll target from any element in the document that already has its id or name', () => {
    const html = `<html><body><p id="${PASSAGE_ID}">Front matter.</p><a name="${PASSAGE_ID}">Index</a><p>Section 2.</p></body></html>`
    const doc = parseDoc(markPassage(html, passageIn(html, 'Section 2.'))!)
    expect(doc.querySelectorAll(`[id="${PASSAGE_ID}"]`)).toHaveLength(1)
    expect(doc.getElementById(PASSAGE_ID)!.tagName).toBe('MARK')
    expect(doc.querySelectorAll(`[name="${PASSAGE_ID}"]`)).toHaveLength(0)
  })

  it('never marks inside a script, a style, or the title, and leaves them as they were', () => {
    const html = '<html><head><title>Section 2.</title><style>p::after{content:"Section 2."}</style></head><body><script>var s = "Section 2."</script><p>Section 2.</p></body></html>'
    const doc = parseDoc(markPassage(html, { quoteAt: at(0, 0), matched: 'Section 2.' })!)
    expect(marksOf(doc)).toHaveLength(1)
    expect(marksOf(doc)[0].parentElement!.tagName).toBe('P')
    expect(doc.title).toBe('Section 2.')
    expect(doc.querySelector('script')!.textContent).toBe('var s = "Section 2."')
  })

  it('keeps the document\'s doctype, or its lack of one', () => {
    expect(markPassage(BILL, passageIn(BILL, 'Section 2.')) ?? '').toMatch(/^<!DOCTYPE html>/)
    const legacy = '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><html><body><p>Section 2.</p></body></html>'
    expect(parseDoc(markPassage(legacy, passageIn(legacy, 'Section 2.'))!).doctype!.publicId).toBe('-//W3C//DTD HTML 4.01 Transitional//EN')
    const none = '<html><body><p>Section 2.</p></body></html>'
    const out = markPassage(none, passageIn(none, 'Section 2.'))
    expect(out ?? '').toMatch(/^<html/)
    expect(parseDoc(out ?? '').compatMode).toBe('BackCompat')
  })
})
