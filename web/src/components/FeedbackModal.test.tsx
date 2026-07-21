import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FeedbackModal } from './FeedbackModal'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(() => Promise.reject(new Error('boom'))),
}))

function renderWithConfig(operator: AppConfig['operator']) {
  const value = { config: { states: [], operator } as AppConfig, multiState: false, loading: false }
  return render(
    <ConfigContext.Provider value={value}>
      <FeedbackModal onClose={() => {}} />
    </ConfigContext.Provider>,
  )
}

describe('FeedbackModal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes the message field with an accessible name', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    render(<FeedbackModal onClose={() => {}} />, { container: root })
    expect(screen.getByRole('textbox', { name: /message|feedback/i })).toBeTruthy()
  })

  it('renders inside a named dialog', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    render(<FeedbackModal onClose={() => {}} />, { container: root })
    expect(screen.getByRole('dialog', { name: /feedback/i })).toBeTruthy()
  })

  it('shows a mailto to all operator contacts (text = first) when the send fails', async () => {
    renderWithConfig({ name: '', url: '', contactEmails: ['a@x.org', 'b@y.org'] })
    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    const link = await waitFor(() => screen.getByRole('link'))
    expect(link).toHaveAttribute('href', 'mailto:a@x.org,b@y.org')
    expect(link).toHaveTextContent('a@x.org')
  })

  it('omits the contact sentence when no operator contacts are configured', async () => {
    renderWithConfig({ name: '', url: '', contactEmails: [] })
    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument())
    expect(screen.queryByRole('link')).toBeNull()
  })
})
