import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
