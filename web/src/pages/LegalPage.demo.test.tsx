import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../lib/api', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }))

import { LegalPage } from './LegalPage'

const DOC = '## Section One\n\nBody text of the document.'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/terms']}>
      <Routes>
        <Route path="/terms" element={<LegalPage title="Terms of Use" content={DOC} />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { fetchMock.mockReset() })

describe('LegalPage — demo tenant', () => {
  // Closes the typed-URL path. The links are already hidden, so reaching this
  // route on a demo means someone entered it by hand.
  it('sends the reader home instead of serving the document', async () => {
    fetchMock.mockResolvedValue({ demoMode: true })
    renderPage()
    await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument())
    expect(screen.queryByText(/Body text of the document/)).toBeNull()
  })

  it('serves the document on a normal tenant', async () => {
    fetchMock.mockResolvedValue({ demoMode: false })
    renderPage()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/auth/demo-mode'))
    expect(screen.getByText(/Body text of the document/)).toBeInTheDocument()
  })

  // A tenant whose endpoint is down is not a demo as far as this page can tell,
  // and silently hiding an operator's legal document is the worse failure.
  it('keeps serving the document when the demo check fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    renderPage()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/auth/demo-mode'))
    expect(screen.getByText(/Body text of the document/)).toBeInTheDocument()
  })
})
