import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BillTextPanel, type HtmlPassageRequest } from './BillTextPanel'
import { billHtmlToText } from '../../../shared/billHtmlToText'
import { PASSAGE_ID } from '../lib/claimLinks'

// Opening a claim's passage in the bill text panel (#571). The text stays in a
// `sandbox=""` frame, which the page can't reach into, so the highlight goes
// into the document before it renders, and the frame goes to the highlight's
// fragment once it loads so the browser scrolls to it. The document is the
// frame's srcdoc, never a blob: URL, which WebKit refuses to frame under the
// app's `frame-ancestors 'none'`. Invented bills A100 and S200, with texts
// that differ.

const A_HTML = '<!DOCTYPE html><html><body><p>A100. Section 1.</p><p>Each county shall have a drop box.</p></body></html>'
const S_HTML = '<!DOCTYPE html><html><body><script>parent.document.title = "x"</script><p>S200. Section 1.</p><p>Front matter.</p><p>Each county shall have a drop box, emptied daily.</p></body></html>'

const TEXT_A = { docId: '9001', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: 'https://leg.example.gov/a100', altStateLink: null }
const TEXT_A2 = { docId: '9003', type: 'Amended', date: '2026-01-05', mime: 'text/html', stateLink: null, altStateLink: null }
const DOC_S = { docId: '9002', type: 'Engrossed', date: '2026-01-02', mime: 'text/html', stateLink: 'https://leg.example.gov/s200', altStateLink: null }

function passageIn(html: string, text: string) {
  const t = billHtmlToText(html)
  const start = t.indexOf(text)
  if (start === -1) throw new Error('fixture')
  return { quoteAt: { start, end: start + text.length }, matched: text }
}

const own = (key = 1): HtmlPassageRequest => ({ key, billId: 'a100', billNumber: 'A100', document: TEXT_A, ...passageIn(A_HTML, 'Each county shall have a drop box.') })
const borrowed = (key = 1): HtmlPassageRequest => ({ key, billId: 's200', billNumber: 'S200', document: DOC_S, ...passageIn(S_HTML, 'Each county shall have a drop box, emptied daily.') })

let fetched: string[]
let blobs: Blob[]
beforeEach(() => {
  fetched = []
  blobs = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    fetched.push(url)
    const body = url === '/api/bills/a100/text/9001' ? A_HTML
      : url === '/api/bills/s200/text/9002' ? S_HTML
      : url === '/api/bills/a100/text/9003' ? '<html><body><p>Amended text.</p></body></html>'
      : null
    if (body === null) return new Response('{}', { status: 404 })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }))
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return `blob:test/${blobs.length}` })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const frame = () => screen.getByTitle(/^Bill text/) as HTMLIFrameElement
const passageFrame = async () => {
  await waitFor(() => expect(frame().title).toMatch(/passage highlighted/))
  return frame()
}
const passageDoc = () => new DOMParser().parseFromString(frame().getAttribute('srcdoc') ?? '', 'text/html')

describe('BillTextPanel: a claim\'s passage on the page bill\'s own text', () => {
  it('opens the pinned document and highlights the passage in the frame\'s own document', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A2, TEXT_A]} externalOpen passage={own()} />)
    const f = await passageFrame()
    expect(fetched).toContain('/api/bills/a100/text/9001')
    expect(f.hasAttribute('src')).toBe(false)
    const doc = passageDoc()
    expect(doc.getElementById(PASSAGE_ID)?.textContent).toBe('Each county shall have a drop box.')
    // The pinned version's chip is the selected one, not the newest.
    expect(screen.getByRole('button', { name: /Introduced/ }).style.background).not.toBe(screen.getByRole('button', { name: /Amended/ }).style.background)
  })

  it('moves focus to the frame showing the passage once it loads', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={own()} />)
    const f = await passageFrame()
    fireEvent.load(f)
    expect(document.activeElement).toBe(f)
  })

  it('opens the passage again, and moves focus again, on a second request', async () => {
    const { rerender } = render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={own(1)} />)
    const first = await passageFrame()
    fireEvent.load(first)
    first.blur()
    rerender(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={own(2)} />)
    // A new frame for the new request, so its load moves focus again.
    await waitFor(() => expect(frame()).not.toBe(first))
    fireEvent.load(frame())
    expect(document.activeElement).toBe(frame())
  })

  it('goes back to the plain text, and lets the highlight go, when the reader picks another version', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[TEXT_A2, TEXT_A]} externalOpen passage={own()} />)
    await passageFrame()
    await user.click(screen.getByRole('button', { name: /Amended/ }))
    await waitFor(() => expect(frame().getAttribute('srcdoc')).toContain('Amended text.'))
    expect(frame().title).toBe('Bill text')
    expect(frame().getAttribute('srcdoc')).not.toContain(PASSAGE_ID)
  })

  it('opens the document without a highlight, and says so, when the passage is no longer in it', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={{ ...own(), matched: 'A passage this version does not have.' }} />)
    expect(await screen.findByText(/couldn.t find the passage/i)).toBeInTheDocument()
    expect(frame().getAttribute('srcdoc')).toContain('Each county shall have a drop box.')
    expect(frame().getAttribute('sandbox')).toBe('')
  })
})

describe('BillTextPanel: a claim\'s passage in a companion\'s text', () => {
  it('opens the analyzed member\'s document, not the page bill\'s, and labels it with its bill', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={borrowed()} />)
    await passageFrame()
    expect(fetched).toContain('/api/bills/s200/text/9002')
    expect(fetched.filter(u => u.startsWith('/api/bills/a100/'))).toEqual([])
    const doc = passageDoc()
    expect(doc.getElementById(PASSAGE_ID)?.textContent).toBe('Each county shall have a drop box, emptied daily.')
    expect(screen.getByRole('button', { name: /S200/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toHaveAttribute('href', '/api/bills/s200/text/9002')
    expect(screen.getByRole('link', { name: /view on legislature/i })).toHaveAttribute('href', 'https://leg.example.gov/s200')
  })

  it('opens it even when the page bill has no texts of its own', async () => {
    render(<BillTextPanel billId="a100" texts={[]} externalOpen passage={borrowed()} />)
    await passageFrame()
    expect(fetched).toEqual(['/api/bills/s200/text/9002'])
  })

  it('goes back to the page bill\'s own text when the reader picks it', async () => {
    const user = userEvent.setup()
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={borrowed()} />)
    await passageFrame()
    await user.click(screen.getByRole('button', { name: /Introduced/ }))
    await waitFor(() => expect(frame().getAttribute('srcdoc')).toContain('A100. Section 1.'))
    expect(fetched).toContain('/api/bills/a100/text/9001')
  })
})

describe('BillTextPanel: the sandbox', () => {
  it('keeps sandbox="" with no permissions on the passage frame, as on the plain one', async () => {
    const { rerender } = render(<BillTextPanel billId="s200" texts={[DOC_S]} externalOpen />)
    await waitFor(() => expect(frame().getAttribute('srcdoc')).toContain('S200. Section 1.'))
    expect(frame().getAttribute('sandbox')).toBe('')
    rerender(<BillTextPanel billId="s200" texts={[DOC_S]} externalOpen passage={borrowed()} />)
    const f = await passageFrame()
    expect(f.getAttribute('sandbox')).toBe('')
    expect(f.hasAttribute('allow')).toBe(false)
  })

  it('hands the frame the document as HTML text, script and all, for the sandbox to keep inert', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={borrowed()} />)
    await passageFrame()
    // The page doesn't strip or run the bill's script: the sandbox is what keeps it from running.
    expect(passageDoc().querySelector('script')?.textContent ?? '').toContain('parent.document.title')
  })

  it('makes no blob: URL for the passage, which WebKit would refuse to frame', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={own()} />)
    await passageFrame()
    expect(blobs).toEqual([])
    expect(frame().hasAttribute('src')).toBe(false)
  })
})

// #696: the ring around the highlight was cut off on the right where the bill's
// text runs to the frame's edge. The ring is drawn inside the mark now.
describe('BillTextPanel: the highlight ring is not cropped (#696)', () => {
  it('draws the passage ring inside the mark, in the document the frame loads, with no outward offset', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={own()} />)
    await passageFrame()
    const doc = passageDoc()
    const css = doc.querySelector('style[data-fv-passage]')?.textContent ?? ''
    expect(css).toContain('outline-offset:-2px')
    expect(css).not.toMatch(/outline-offset:\s*[0-9]/)
  })

  it('shows no quote box for an HTML passage: the highlight in the text is the quote', async () => {
    render(<BillTextPanel billId="a100" texts={[TEXT_A]} externalOpen passage={own()} />)
    await passageFrame()
    expect(screen.queryByRole('group', { name: /quote behind the claim/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /close quote/i })).toBeNull()
  })
})
