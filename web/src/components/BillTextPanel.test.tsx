import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BillTextPanel } from './BillTextPanel'

// BillTextPanel loads text via the global fetch on open. Stub it with a resolved,
// empty text response so the load effect settles cleanly (the link row renders
// independent of load state, but resolving avoids act warnings).
function stubFetch() {
  const res = {
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob([]),
    headers: { get: () => 'text/html; charset=utf-8' },
  }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res as unknown as Response)))
}

describe('BillTextPanel — legislature link', () => {
  beforeEach(() => {
    stubFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows "View on legislature" for a PDF text with a stateLink', async () => {
    render(
      <BillTextPanel
        billId="legiscan:123"
        externalOpen
        texts={[{ docId: '1', type: 'Introduced', date: '2026-01-01', mime: 'application/pdf', stateLink: 'https://leg.example.gov/pdf/1', altStateLink: null }]}
      />,
    )
    const link = await screen.findByRole('link', { name: /view on legislature/i })
    expect(link).toHaveAttribute('href', 'https://leg.example.gov/pdf/1')
  })

  it('shows "View on legislature" for an HTML text with a stateLink', async () => {
    render(
      <BillTextPanel
        billId="legiscan:123"
        externalOpen
        texts={[{ docId: '1', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: 'https://leg.example.gov/html/1', altStateLink: null }]}
      />,
    )
    const link = await screen.findByRole('link', { name: /view on legislature/i })
    expect(link).toHaveAttribute('href', 'https://leg.example.gov/html/1')
  })

  it('still offers "Download PDF" for an HTML text that has an altStateLink', async () => {
    render(
      <BillTextPanel
        billId="legiscan:123"
        externalOpen
        texts={[{ docId: '1', type: 'Introduced', date: '2026-01-01', mime: 'text/html', stateLink: 'https://leg.example.gov/html/1', altStateLink: 'https://leg.example.gov/pdf/1' }]}
      />,
    )
    expect(await screen.findByRole('link', { name: /view on legislature/i })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: /download pdf/i })).toBeInTheDocument()
  })
})

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const pdfText = (stateLink: string | null) => [
  { docId: '7', type: 'Introduced', date: '2026-01-01', mime: 'application/pdf', stateLink, altStateLink: null },
]

describe('BillTextPanel — PDF where inline rendering is unavailable', () => {
  beforeEach(() => {
    stubFetch()
    URL.createObjectURL = () => 'blob:test'
    URL.revokeObjectURL = () => {}
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows an "Open PDF" card that opens the document top-level, and no iframe, on iOS', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 })
    const { container } = render(<BillTextPanel billId="legiscan:123" externalOpen texts={pdfText('https://leg.example.gov/pdf/7')} />)
    const open = await screen.findByRole('link', { name: /open pdf/i })
    expect(open).toHaveAttribute('href', '/api/bills/legiscan:123/text/7')
    expect(open).toHaveAttribute('target', '_blank')
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('link', { name: /view on legislature/i })).toHaveAttribute('href', 'https://leg.example.gov/pdf/7')
  })

  it('omits "View on legislature" from the card when there is no source link', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 })
    render(<BillTextPanel billId="legiscan:123" externalOpen texts={pdfText(null)} />)
    await screen.findByRole('link', { name: /open pdf/i })
    expect(screen.queryByRole('link', { name: /view on legislature/i })).toBeNull()
  })

  it('keeps the inline iframe and no card on a desktop browser that renders PDFs', async () => {
    vi.stubGlobal('navigator', { userAgent: DESKTOP_UA, maxTouchPoints: 0, pdfViewerEnabled: true })
    const { container } = render(<BillTextPanel billId="legiscan:123" externalOpen texts={pdfText('https://leg.example.gov/pdf/7')} />)
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(screen.queryByRole('link', { name: /open pdf/i })).toBeNull()
    expect(screen.getByRole('link', { name: /open in new tab/i })).toBeInTheDocument()
  })
})
