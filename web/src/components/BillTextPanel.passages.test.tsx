import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillTextPanel, type HtmlPassageRequest, type PdfPageRequest } from './BillTextPanel'
import { billHtmlToText } from '../../../shared/billHtmlToText'
import { PASSAGE_ID } from '../lib/claimLinks'

// A claim with several passages in the bill text panel (#802). Invented bill A100.

const HTML = '<!DOCTYPE html><html><body><p>Section 1. The secretary shall adopt rules.</p><p>Section 2. Each county shall have a drop box.</p><p>Section 3. Boxes are emptied daily.</p></body></html>'
const TEXT = { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: null, altStateLink: null }
const PDF = { ...TEXT, docId: '9101', mime: 'application/pdf' }
const PDF_BYTES = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'

function passageIn(text: string) {
  const start = billHtmlToText(HTML).indexOf(text)
  return { quoteAt: { start, end: start + text.length }, matched: text }
}
const htmlRequest = (): HtmlPassageRequest => ({
  key: 1, billId: 'a100', billNumber: 'A100', document: TEXT,
  ...passageIn('The secretary shall adopt rules.'),
  rest: [passageIn('Each county shall have a drop box.'), passageIn('Boxes are emptied daily.')],
})
const pdfRequest = (): PdfPageRequest => ({
  key: 1, billId: 'a100', billNumber: 'A100', document: PDF,
  quote: 'Quote one.', page: 2, rest: [{ quote: 'Quote two.', page: 9 }],
})

let blobs: Blob[]
beforeEach(() => {
  blobs = []
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', maxTouchPoints: 0, pdfViewerEnabled: true })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/9001')) return new Response(HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    if (url.endsWith('/9101')) return new Response(PDF_BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    return new Response('{}', { status: 404 })
  }))
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return `blob:test/${blobs.length}` })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('BillTextPanel: an HTML claim with three passages', () => {
  it('highlights every passage, opens at the first, and gives one element the fragment id', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT]} externalOpen passage={htmlRequest()} />)
    const f = await waitFor(() => {
      const el = screen.getByTitle(/^Bill text/) as HTMLIFrameElement
      expect(el.getAttribute('src') ?? '').toMatch(/^blob:/)
      return el
    })
    expect(f.getAttribute('src')).toBe(`blob:test/${blobs.length}#${PASSAGE_ID}`)
    const doc = new DOMParser().parseFromString(await blobs[blobs.length - 1].text(), 'text/html')
    expect([...doc.querySelectorAll('mark[data-fv-passage]')].map(m => m.textContent)).toEqual([
      'The secretary shall adopt rules.', 'Each county shall have a drop box.', 'Boxes are emptied daily.',
    ])
    expect(doc.querySelectorAll(`[id="${PASSAGE_ID}"]`)).toHaveLength(1)
    expect(doc.getElementById(PASSAGE_ID)!.textContent).toBe('The secretary shall adopt rules.')
  })
})

describe('BillTextPanel: a PDF claim with two quotes', () => {
  const frame = () => screen.getByTitle('Bill text') as HTMLIFrameElement

  it('lists both quotes under their pages, opens at the first page, and moves to the page of a label that is selected', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF]} externalOpen passage={pdfRequest()} />)
    await waitFor(() => expect(screen.queryByTitle('Bill text')).not.toBeNull())
    const cap = screen.getByRole('group', { name: /quote behind the claim/i })
    expect([...cap.querySelectorAll('blockquote')].map(b => b.textContent)).toEqual(['“Quote one.”', '“Quote two.”'])
    expect(frame().getAttribute('src')).toBe('blob:test/1#page=2')
    await user.click(screen.getByRole('link', { name: 'Page 9' }))
    expect(frame().getAttribute('src')).toBe('blob:test/1#page=9')
    await user.click(screen.getByRole('link', { name: 'Page 2' }))
    expect(frame().getAttribute('src')).toBe('blob:test/1#page=2')
  })
})
