import { describe, it, expect } from 'vitest'
import { billHtmlToText } from '../../../shared/billHtmlToText'
import { linkableClaims, markPassage, PASSAGE_ID, type ClaimSourceItem, type ClaimSourcesDetail } from './claimLinks'

// A claim that cites several passages (#802): one link, every passage
// highlighted, the frame opening at the first. Invented text.

const HTML_DOC = { docId: '9002', type: 'Introduced', date: '2026-01-02', mime: 'text/html', stateLink: null, altStateLink: null }
const PDF_DOC = { ...HTML_DOC, mime: 'application/pdf' }
const cs = (items: ClaimSourceItem[], document = HTML_DOC): ClaimSourcesDetail => ({ billId: 's200', document, items })

const BILL = '<!DOCTYPE html><html><body><p>Section 1. The secretary shall adopt rules.</p><p>Section 2. Each county shall have a drop box.</p><p>Section 3. Boxes are emptied daily.</p></body></html>'
const P1 = 'The secretary shall adopt rules.'
const P2 = 'Each county shall have a drop box.'
const P3 = 'Boxes are emptied daily.'
function passageIn(text: string) {
  const start = billHtmlToText(BILL).indexOf(text)
  if (start === -1) throw new Error('fixture')
  return { quoteAt: { start, end: start + text.length }, matched: text }
}
const item = (claim: string, text: string, status: ClaimSourceItem['status'] = 'exact'): ClaimSourceItem => ({ claim, status, ...passageIn(text) })
const parseDoc = (html: string) => new DOMParser().parseFromString(html, 'text/html')
const marksOf = (doc: Document) => [...doc.querySelectorAll('mark[data-fv-passage]')]

describe('linkableClaims: a claim with several items', () => {
  it('is one link, made from its first item, that carries the other passages', () => {
    const items = [item('Drop boxes.', P1), item('Other.', P3), item('Drop boxes.', P2), item('Drop boxes.', P3)]
    const links = linkableClaims(cs(items), true)
    expect(links.map(l => [l.index, l.claim])).toEqual([[0, 'Drop boxes.'], [1, 'Other.']])
    expect((links[0] as { rest?: unknown }).rest).toEqual([
      { matched: P2, quoteAt: items[2].quoteAt },
      { matched: P3, quoteAt: items[3].quoteAt },
    ])
    expect('rest' in links[1]).toBe(false)
  })

  it('links from the first item that was found when an earlier one was not', () => {
    const items: ClaimSourceItem[] = [{ claim: 'Drop boxes.', status: 'ungrounded' }, item('Drop boxes.', P2), item('Drop boxes.', P3)]
    const [link] = linkableClaims(cs(items), true)
    expect(link.index).toBe(1)
    expect((link as { rest?: unknown[] }).rest).toHaveLength(1)
  })

  it('previews every passage of the claim', () => {
    const [link] = linkableClaims(cs([item('Drop boxes.', P1), item('Drop boxes.', P2)]), true)
    expect(link.popover).toContain(P1)
    expect(link.popover).toContain(P2)
  })

  it('carries every quote and page of a PDF claim, the first as the link\'s own', () => {
    const pdf = (quote: string, page: number): ClaimSourceItem => ({ claim: 'Drop boxes.', status: 'unverified', quote, page })
    const [link] = linkableClaims(cs([pdf('Quote one.', 2), pdf('Quote two.', 9)], PDF_DOC), true)
    expect(link).toMatchObject({ index: 0, quote: 'Quote one.', page: 2, rest: [{ quote: 'Quote two.', page: 9 }] })
    expect(link.popover).toContain('Page 2')
    expect(link.popover).toContain('Page 9')
  })
})

describe('linkableClaims: an anchored item', () => {
  it('previews the model\'s whole quote, not the 32-character anchor', () => {
    const quote = 'Each county shall have a drop box for the return of voted ballots, emptied daily.'
    const anchored: ClaimSourceItem = { claim: 'Drop boxes.', status: 'anchored', quoteAt: { start: 0, end: 32 }, matched: quote.slice(0, 32), quote }
    const [link] = linkableClaims(cs([anchored]), true)
    expect(link.popover).toBe(`“${quote}”`)
  })
})

describe('markPassage with several passages', () => {
  const all = [passageIn(P1), passageIn(P2), passageIn(P3)]

  it('marks every passage, and gives the fragment id to one element only', () => {
    const doc = parseDoc(markPassage(BILL, all)!)
    expect(marksOf(doc).map(m => m.textContent).join('')).toBe(P1 + P2 + P3)
    expect(doc.querySelectorAll(`[id="${PASSAGE_ID}"]`)).toHaveLength(1)
    expect(doc.getElementById(PASSAGE_ID)!.textContent).toBe(P1)
    expect(doc.getElementById(PASSAGE_ID)!.getAttribute('tabindex')).toBe('-1')
    expect(doc.querySelectorAll('mark[tabindex]')).toHaveLength(1)
  })

  it('still marks the others when one is not found, and targets the first one found', () => {
    const missing = { quoteAt: { start: 0, end: 10 }, matched: 'Never in the bill at all.' }
    const doc = parseDoc(markPassage(BILL, [missing, all[1], all[2]])!)
    expect(marksOf(doc).map(m => m.textContent).join('')).toBe(P2 + P3)
    expect(doc.getElementById(PASSAGE_ID)!.textContent).toBe(P2)
  })

  it('marks a passage that repeats once, without nesting or a second id', () => {
    const doc = parseDoc(markPassage(BILL, [passageIn(P2), passageIn(P2), passageIn(P3)])!)
    expect(marksOf(doc).map(m => m.textContent)).toEqual([P2, P3])
    expect(doc.querySelector('mark mark')).toBeNull()
    expect(doc.querySelectorAll(`[id="${PASSAGE_ID}"]`)).toHaveLength(1)
  })

  it('is null when none is found', () => {
    expect(markPassage(BILL, [{ quoteAt: { start: 0, end: 1 }, matched: 'Nothing here.' }])).toBeNull()
  })
})

describe('the passage focus ring', () => {
  const css = () => parseDoc(markPassage(BILL, passageIn(P2))!).head.querySelector('style[data-fv-passage]')!.textContent!

  it('shows on :focus-visible, so a mouse reader sees no ring', () => {
    expect(css()).toContain(`#${PASSAGE_ID}:focus-visible{outline:2px solid`)
    expect(css()).not.toContain(`#${PASSAGE_ID}:focus{`)
  })

  it('has no rule that outlines every mark', () => {
    expect(css()).not.toContain(':has(')
    expect(css()).not.toMatch(/mark\[data-fv-passage\]\{[^}]*outline/)
  })
})
