import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FeedbackModal } from './FeedbackModal'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

const apiFetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(() =>
  Promise.reject(new Error('boom')),
)

vi.mock('../lib/api', () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
}))

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

function renderWithConfig(operator: AppConfig['operator']) {
  const value = { config: { states: [], operator } as AppConfig, multiState: false, loading: false }
  return render(
    <ConfigContext.Provider value={value}>
      <FeedbackModal onClose={() => {}} />
    </ConfigContext.Provider>,
  )
}

describe('FeedbackModal', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiFetchMock.mockImplementation(() => Promise.reject(new Error('boom')))
    mockMatchMedia(false) // desktop by default
  })

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

  it('autofocuses the message textarea on open', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    render(<FeedbackModal onClose={() => {}} />, { container: root })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /message/i }))
  })

  it('submits on Cmd+Enter in the textarea', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    apiFetchMock.mockResolvedValueOnce(undefined)
    render(<FeedbackModal onClose={() => {}} />, { container: root })
    const textarea = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    expect(apiFetchMock).toHaveBeenCalledWith('/feedback', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(screen.getByText(/feedback sent/i)).toBeInTheDocument())
  })

  it('submits on Ctrl+Enter in the textarea', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    apiFetchMock.mockResolvedValueOnce(undefined)
    render(<FeedbackModal onClose={() => {}} />, { container: root })
    const textarea = screen.getByRole('textbox', { name: /message/i })
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
  })

  it('does not submit on Cmd+Enter when the message is empty', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    render(<FeedbackModal onClose={() => {}} />, { container: root })
    const textarea = screen.getByRole('textbox', { name: /message/i })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('shows a platform-aware hint to send with the keyboard', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    render(<FeedbackModal onClose={() => {}} />, { container: root })
    expect(screen.getByText(/to send/i)).toBeInTheDocument()
  })

  it('hides the keyboard hint on mobile, but shows it on desktop', () => {
    const mobileRoot = document.createElement('div'); mobileRoot.id = 'root'; document.body.appendChild(mobileRoot)
    mockMatchMedia(true) // mobile: matches (max-width: 767px)
    const { unmount } = render(<FeedbackModal onClose={() => {}} />, { container: mobileRoot })
    expect(screen.queryByText(/to send/i)).toBeNull()
    unmount()
    mobileRoot.remove()

    const desktopRoot = document.createElement('div'); desktopRoot.id = 'root'; document.body.appendChild(desktopRoot)
    mockMatchMedia(false) // desktop: no match
    render(<FeedbackModal onClose={() => {}} />, { container: desktopRoot })
    expect(screen.getByText(/to send/i)).toBeInTheDocument()
  })

  it('hides the keyboard hint while sending, but shows it in the editable state', async () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    apiFetchMock.mockImplementation(() => new Promise(() => {})) // never resolves — stays in 'sending'
    render(<FeedbackModal onClose={() => {}} />, { container: root })

    expect(screen.getByText(/to send/i)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText("What's on your mind?"), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument())
    expect(screen.queryByText(/to send/i)).toBeNull()
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
