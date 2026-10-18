import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillTextPanel, type PassageRequest, type PdfPageRequest } from './BillTextPanel'

// Opening a PDF claim's page in the bill text panel (#572). The PDF frame
// can't carry a `sandbox`: Chromium's built-in viewer renders under no sandbox
// value (probed with `sandbox=""` and every `allow-*` token). So the frame is
// kept safe another way: its blob is always typed `application/pdf`, whatever
// the response says, and bytes that aren't a PDF never reach a frame. The
// viewer opens at `#page=N`, and a loaded viewer ignores a fragment-only
// change, so each request gets a new frame. Invented bills A100 and S200.

const PDF_BYTES = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'
const HTML_BYTES = '<!DOCTYPE html><html><body><h1>Not found</h1><script>parent.document.title = "x"</script></body></html>'

const PDF_A = { docId: '9101', type: 'Introduced', date: '2026-01-01', mime: 'application/pdf', stateLink: 'https://leg.example.gov/a100.pdf', altStateLink: null }
const PDF_A2 = { docId: '9103', type: 'Amended', date: '2026-01-05', mime: 'application/pdf', stateLink: null, altStateLink: null }
const DOC_S = { docId: '9102', type: 'Engrossed', date: '2026-01-02', mime: 'application/pdf', stateLink: null, altStateLink: null }
const QUOTE = 'Each county shall have a drop box.'

const ask = (key: number, page: unknown, quote = QUOTE): PassageRequest =>
  ({ key, billId: 'a100', billNumber: 'A100', document: PDF_A, quote, page: page as number | null })
const askS = (key: number, page: unknown): PassageRequest =>
  ({ key, billId: 's200', billNumber: 'S200', document: DOC_S, quote: 'Two employees empty each box.', page: page as number | null })

const DESKTOP = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', maxTouchPoints: 0, pdfViewerEnabled: true }
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 }

let fetched: string[]
let blobs: Blob[]
let responses: Record<string, () => Response>
beforeEach(() => {
  fetched = []
  blobs = []
  responses = {}
  vi.stubGlobal('navigator', DESKTOP)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    fetched.push(url)
    const make = responses[url]
    if (make) return make()
    if (/^\/api\/bills\/(a100|s200)\/text\/(9101|9102|9103)$/.test(url)) {
      return new Response(PDF_BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    }
    return new Response('{}', { status: 404 })
  }))
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return `blob:test/${blobs.length}` })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const frame = () => screen.getByTitle('Bill text') as HTMLIFrameElement
const loadedFrame = async () => {
  await waitFor(() => expect(screen.queryByTitle('Bill text')).not.toBeNull())
  return frame()
}
const caption = () => screen.getByRole('group', { name: /quote behind the claim/i })

describe('BillTextPanel: a PDF claim\'s page on the page bill\'s own text', () => {
  it('opens the pinned PDF from the analysis\'s bill, at the cited page', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A2, PDF_A]} externalOpen passage={ask(1, 7)} />)
    const f = await loadedFrame()
    expect(fetched).toEqual(['/api/bills/a100/text/9101'])
    expect(f.getAttribute('src')).toBe(`blob:test/1#page=7`)
    expect(f.hasAttribute('srcdoc')).toBe(false)
  })

  it('selects the pinned version\'s chip, not the newest', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A2, PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    expect(screen.getByRole('button', { name: /Introduced/ }).style.background).not.toBe(screen.getByRole('button', { name: /Amended/ }).style.background)
  })

  it('shows the quote and the page in a captioned group beside the frame', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    const cap = caption()
    expect(cap).toHaveTextContent('Page 7')
    expect(cap.querySelector('blockquote')!.textContent).toBe(`“${QUOTE}”`)
  })

  it('moves focus to the caption, once, so keyboard and screen reader users get the quote', async () => {
    const { rerender } = render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    // The same request again (a parent re-render) does not take focus back.
    ;(document.activeElement as HTMLElement).blur()
    rerender(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    expect(caption()).not.toHaveFocus()
  })

  it('opens at page 1, and says no page was cited, when the claim has none', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, null)} />)
    const f = await loadedFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=1')
    expect(caption()).toHaveTextContent('No page was cited, so the PDF opens at page 1')
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${QUOTE}”`)
  })

  it.each([0, -2, 2.5, NaN])('opens at page 1, with the quote still shown, for a cited page of %s', async cited => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, cited)} />)
    const f = await loadedFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=1')
    expect(caption()).toHaveTextContent('isn’t usable, so the PDF opens at page 1')
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${QUOTE}”`)
  })

  it('leaves a page past the end of the file to the viewer, which shows the last page, with the quote shown', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 9999)} />)
    const f = await loadedFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=9999')
    expect(caption()).toHaveTextContent('Page 9999')
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${QUOTE}”`)
  })

  it('opens a second request in a new frame at its page, and moves focus to its quote again', async () => {
    const { rerender } = render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 2)} />)
    const first = await loadedFrame()
    await waitFor(() => expect(caption()).toHaveFocus())
    ;(document.activeElement as HTMLElement).blur()
    rerender(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(2, 9, 'A different quote.')} />)
    await waitFor(() => expect(frame().getAttribute('src')).toBe('blob:test/1#page=9'))
    // A loaded viewer ignores a fragment-only change, so the frame is a new element.
    expect(frame()).not.toBe(first)
    expect(first.isConnected).toBe(false)
    expect(caption().querySelector('blockquote')!.textContent).toBe('“A different quote.”')
    await waitFor(() => expect(caption()).toHaveFocus())
    // The file was fetched once, and its blob reused.
    expect(fetched).toEqual(['/api/bills/a100/text/9101'])
  })

  it('opens the same page again, in a new frame, when the same claim is asked for twice', async () => {
    const { rerender } = render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 3)} />)
    const first = await loadedFrame()
    rerender(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(2, 3)} />)
    await waitFor(() => expect(frame()).not.toBe(first))
    expect(frame().getAttribute('src')).toBe('blob:test/1#page=3')
  })

  it('goes back to the plain PDF, with no page and no caption, when the reader picks another version', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF_A2, PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    await user.click(screen.getByRole('button', { name: /Amended/ }))
    await waitFor(() => expect(frame().getAttribute('src')).toBe('blob:test/2'))
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })

  it('shows the PDF as before, with no fragment and no caption, when no claim was opened', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen />)
    const f = await loadedFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1')
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })

  it('gives "Open in new tab" the cited page', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/bills/a100/text/9101#page=7')
  })

  it('gives "Open in new tab" page 1 when the cited page is unusable', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 0)} />)
    await loadedFrame()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/bills/a100/text/9101#page=1')
  })

  it('leaves "Open in new tab" without a page when no claim was opened', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen />)
    await loadedFrame()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/bills/a100/text/9101')
  })

  it('shows the quote, and the cited page on "Open PDF", where the browser can\'t show a PDF inline', async () => {
    vi.stubGlobal('navigator', IPHONE)
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    const open = await screen.findByRole('link', { name: /open pdf/i })
    expect(open).toHaveAttribute('href', '/api/bills/a100/text/9101#page=7')
    expect(screen.queryByTitle('Bill text')).toBeNull()
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${QUOTE}”`)
  })

  it('still shows the quote when the PDF can\'t be loaded', async () => {
    responses['/api/bills/a100/text/9101'] = () => new Response('{}', { status: 404 })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    expect(await screen.findByText(/text not cached/i)).toBeInTheDocument()
    expect(screen.queryByTitle('Bill text')).toBeNull()
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${QUOTE}”`)
  })
})

describe('BillTextPanel: the PDF frame\'s type and bytes', () => {
  it.each([
    ['text/html; charset=utf-8'],
    ['text/html'],
    ['application/octet-stream'],
    ['image/svg+xml'],
    [''],
  ])('builds the blob as application/pdf when the response says %j', async contentType => {
    responses['/api/bills/a100/text/9101'] = () => new Response(PDF_BYTES, { status: 200, headers: contentType ? { 'Content-Type': contentType } : {} })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 2)} />)
    await loadedFrame()
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('application/pdf')
    expect(await blobs[0].text()).toBe(PDF_BYTES)
  })

  it('builds the blob as application/pdf for a plain open too, with no claim', async () => {
    responses['/api/bills/a100/text/9101'] = () => new Response(PDF_BYTES, { status: 200, headers: { 'Content-Type': 'text/html' } })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen />)
    await loadedFrame()
    expect(blobs[0].type).toBe('application/pdf')
  })

  it('accepts a PDF with a few bytes before its header', async () => {
    responses['/api/bills/a100/text/9101'] = () => new Response('\n\n' + PDF_BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen />)
    await loadedFrame()
    expect(blobs[0].type).toBe('application/pdf')
  })

  it('keeps the frame without a sandbox, which Chromium\'s PDF viewer needs, and with no srcdoc', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    const f = await loadedFrame()
    // Chromium's viewer renders in no sandboxed frame, under any value of the
    // attribute, so there is none to set. The safety is in the type and the bytes.
    expect(f.hasAttribute('sandbox')).toBe(false)
    expect(f.hasAttribute('srcdoc')).toBe(false)
    expect(blobs.every(b => b.type === 'application/pdf')).toBe(true)
  })

  it('does not render an HTML page served under a PDF\'s key: no frame, no blob, and a link out instead', async () => {
    responses['/api/bills/a100/text/9101'] = () => new Response(HTML_BYTES, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    expect(await screen.findByText(/isn.t a pdf/i)).toBeInTheDocument()
    expect(screen.queryByTitle('Bill text')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    expect(blobs).toHaveLength(0)
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/bills/a100/text/9101#page=7')
    expect(screen.getByRole('link', { name: /view on legislature/i })).toHaveAttribute('href', 'https://leg.example.gov/a100.pdf')
    // The quote is still there for the reader.
    expect(caption().querySelector('blockquote')!.textContent).toBe(`“${QUOTE}”`)
  })

  it('does not render an empty body or a truncated header as a PDF', async () => {
    responses['/api/bills/a100/text/9101'] = () => new Response('', { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen />)
    expect(await screen.findByText(/isn.t a pdf/i)).toBeInTheDocument()
    expect(blobs).toHaveLength(0)
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('reads the page and the quote when the caption group is focused, for every screen reader', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    const cap = caption()
    const ids = (cap.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    expect(ids).toHaveLength(2)
    expect(ids.map(id => document.getElementById(id)?.tagName)).toEqual(['P', 'BLOCKQUOTE'])
    expect(cap).toHaveAccessibleDescription(`Page 7 “${QUOTE}”`)
  })

  it('describes the caption by the fallback sentence too, when the page is unusable', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 0)} />)
    await loadedFrame()
    expect(caption()).toHaveAccessibleDescription(`The cited page isn’t usable, so the PDF opens at page 1 “${QUOTE}”`)
  })

  it('shows the PDF, not the fallback, when a later load succeeds after a non-PDF answer', async () => {
    let calls = 0
    responses['/api/bills/a100/text/9101'] = () => (++calls === 1
      ? new Response(HTML_BYTES, { status: 200, headers: { 'Content-Type': 'text/html' } })
      : new Response(PDF_BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } }))
    const { rerender } = render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    expect(await screen.findByText(/isn.t a pdf/i)).toBeInTheDocument()
    expect(screen.queryByTitle('Bill text')).toBeNull()
    rerender(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(2, 7)} />)
    const f = await loadedFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=7')
    expect(screen.queryByText(/isn.t a pdf/i)).toBeNull()
    expect(calls).toBe(2)
  })

  it('frames a body that starts with the PDF header but carries HTML after it only as a PDF, never as HTML', async () => {
    const polyglot = '%PDF-1.4\n<!DOCTYPE html><html><body><h1>Injected</h1><script>parent.document.title = "x"</script></body></html>'
    responses['/api/bills/a100/text/9101'] = () => new Response(polyglot, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 2)} />)
    const f = await loadedFrame()
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('application/pdf')
    expect(await blobs[0].text()).toBe(polyglot)
    expect(f.getAttribute('src')).toBe('blob:test/1#page=2')
    expect(f.hasAttribute('srcdoc')).toBe(false)
    // The page never parses it: no element from the body is in the document.
    expect(document.querySelector('h1')).toBeNull()
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('does not render a non-PDF as a plain open either, with no claim', async () => {
    responses['/api/bills/a100/text/9101'] = () => new Response(HTML_BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen />)
    expect(await screen.findByText(/isn.t a pdf/i)).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
  })
})

describe('BillTextPanel: a PDF claim\'s page in a companion\'s file', () => {
  it('opens the analyzed member\'s PDF at its page, never the page bill\'s own, labeled with its bill', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askS(1, 12)} />)
    const f = await loadedFrame()
    expect(fetched).toEqual(['/api/bills/s200/text/9102'])
    expect(f.getAttribute('src')).toBe('blob:test/1#page=12')
    expect(f.hasAttribute('sandbox')).toBe(false)
    expect(blobs[0].type).toBe('application/pdf')
    expect(screen.getByRole('button', { name: /S200/ })).toBeInTheDocument()
    expect(caption().querySelector('blockquote')!.textContent).toBe('“Two employees empty each box.”')
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/bills/s200/text/9102#page=12')
  })

  it('opens the companion\'s PDF even when the page bill has no texts of its own', async () => {
    render(<BillTextPanel billId="a100" texts={[]} externalOpen passage={askS(1, 4)} />)
    const f = await loadedFrame()
    expect(f.getAttribute('src')).toBe('blob:test/1#page=4')
    expect(fetched.filter(u => u.startsWith('/api/bills/a100/'))).toEqual([])
  })

  it('goes back to the page bill\'s own version, with no caption, when the reader picks it', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askS(1, 12)} />)
    await loadedFrame()
    await user.click(screen.getByRole('button', { name: /Introduced/ }))
    await waitFor(() => expect(fetched).toContain('/api/bills/a100/text/9101'))
    await waitFor(() => expect(frame().getAttribute('src')).toBe('blob:test/2'))
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })
})

// #696: the quote box above a PDF wears the preview's glow, animates in (not
// under reduced motion), and closes by button and by Escape, returning focus to
// the claim that opened it.
describe('BillTextPanel: the PDF quote box (#696)', () => {
  const closeButton = () => screen.getByRole('button', { name: /close quote/i })
  const claimLink = (n: number) => {
    const a = document.createElement('a')
    a.href = '#fv-claim-passage'
    a.className = 'claim-link'
    a.setAttribute('data-claim', String(n))
    a.textContent = `Claim ${n}`
    document.body.appendChild(a)
    return a
  }
  const askFrom = (key: number, opener: HTMLElement | null, page: unknown = 7): PassageRequest => ({ ...(ask(key, page) as PdfPageRequest), opener })
  afterEach(() => { document.querySelectorAll('a.claim-link').forEach(a => a.remove()) })

  it('wears the glow from the glow tokens, on the card surface', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    const cap = caption()
    expect(cap.style.border).toContain('var(--fv-claim-glow-border)')
    expect(cap.style.boxShadow).toContain('var(--fv-claim-glow-halo)')
    expect(cap.style.boxShadow).toContain('var(--fv-claim-glow-blur)')
    expect(cap.style.background).toContain('var(--fv-white)')
  })

  it('animates in with a class whose keyframes flash the glow tokens, and sets no motion under reduced motion', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    expect(caption()).toHaveClass('claim-quote-box')
    const css = [...document.querySelectorAll('style')].map(s => s.textContent ?? '').join('\n')
    expect(css).toMatch(/@keyframes claim-quote-in\s*\{[^]*var\(--fv-claim-flash-halo\)[^]*var\(--fv-claim-flash-blur\)/)
    expect(css).toMatch(/\.claim-quote-box\s*\{[^}]*animation:\s*claim-quote-in/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.claim-quote-box\s*\{[^}]*animation:\s*none/)
  })

  it('has a close button, named for a screen reader, that Tab reaches from the focused box', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    expect(closeButton()).toHaveAttribute('type', 'button')
    await user.tab()
    expect(closeButton()).toHaveFocus()
  })

  it('closes the box with its button, and leaves the PDF where it was', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    const f = await loadedFrame()
    await user.click(closeButton())
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
    expect(frame()).toBe(f)
    expect(f.getAttribute('src')).toBe('blob:test/1#page=7')
  })

  it('closes the box with Escape from the box itself', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })

  it('closes the box with Escape from its close button', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.tab()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })

  it('does not close on Escape pressed elsewhere on the page', async () => {
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 7)} />)
    await loadedFrame()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(caption()).toBeInTheDocument()
  })

  it('returns focus to the claim that opened it when the button closes the box', async () => {
    const user = userEvent.setup()
    const link = claimLink(3)
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(1, link)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.click(closeButton())
    expect(link).toHaveFocus()
  })

  it('returns focus to the claim when Escape closes the box', async () => {
    const user = userEvent.setup()
    const link = claimLink(3)
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(1, link)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(link).toHaveFocus()
  })

  it('finds the claim again by its index when the summary re-rendered and the opener left the document', async () => {
    const user = userEvent.setup()
    const stale = claimLink(3)
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(1, stale)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    stale.remove()
    const fresh = claimLink(3)
    const other = claimLink(4)
    await user.click(closeButton())
    expect(fresh).toHaveFocus()
    expect(other).not.toHaveFocus()
  })

  it('closes cleanly, with focus off the removed box, when there is no claim to return to', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(1, null)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.click(closeButton())
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
    expect(document.activeElement === null || document.activeElement === document.body || document.activeElement.isConnected).toBe(true)
  })

  it('opens the box again when the claim is clicked again, and takes focus to it', async () => {
    const user = userEvent.setup()
    const link = claimLink(3)
    const { rerender } = render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(1, link)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.click(closeButton())
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
    rerender(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(2, link)} />)
    await waitFor(() => expect(caption()).toBeInTheDocument())
    await waitFor(() => expect(caption()).toHaveFocus())
    expect(caption().querySelector('blockquote')!.textContent).toBe(`\u201c${QUOTE}\u201d`)
  })

  it('keeps the box closed through a re-render of the same request', async () => {
    const user = userEvent.setup()
    const link = claimLink(3)
    const { rerender } = render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(1, link)} />)
    await waitFor(() => expect(caption()).toHaveFocus())
    await user.click(closeButton())
    rerender(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={askFrom(1, link)} />)
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })

  it('closes a long quote\'s box the same way, and shows the whole quote while open', async () => {
    const user = userEvent.setup()
    const long = 'The board shall review every drop box location and report each finding. '.repeat(30).trim()
    render(<BillTextPanel billId="a100" texts={[PDF_A]} externalOpen passage={ask(1, 2, long)} />)
    await loadedFrame()
    expect(caption().querySelector('blockquote')!.textContent).toBe(`\u201c${long}\u201d`)
    await user.click(closeButton())
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
  })

  it('drops the box when the reader picks a version, and the claim opens it again', async () => {
    const user = userEvent.setup()
    const link = claimLink(3)
    const { rerender } = render(<BillTextPanel billId="a100" texts={[PDF_A2, PDF_A]} externalOpen passage={askFrom(1, link)} />)
    await loadedFrame()
    await user.click(screen.getByRole('button', { name: /Amended/ }))
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
    rerender(<BillTextPanel billId="a100" texts={[PDF_A2, PDF_A]} externalOpen passage={askFrom(2, link)} />)
    await waitFor(() => expect(caption()).toBeInTheDocument())
  })
})
