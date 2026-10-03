import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FeedbackModal } from './FeedbackModal'
import { itGatesQuietly, expectMessageHidden, expectMessageShown, gateMessage } from '../test/quietGate'

// The quiet required-field gate on the feedback form: the message is required.
// "Send feedback" looks disabled while it is empty and says
// "Fill in the required items first." only when someone tries it.

const apiFetchMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>()

vi.mock('../lib/api', () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
}))

function renderModal() {
  const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
  return render(<FeedbackModal onClose={() => {}} />, { container: root })
}

const message = () => screen.getByRole('textbox', { name: /message/i })
const sendButton = () => screen.getByRole('button', { name: /send feedback|sending/i })
const posts = () => apiFetchMock.mock.calls.filter(([p]) => p === '/feedback').length

beforeEach(() => {
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue(undefined)
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })))
})

describe('FeedbackModal: quiet gate while the message is empty', () => {
  itGatesQuietly(async () => {
    const user = userEvent.setup()
    renderModal()
    return { user, button: sendButton, submitted: posts }
  })

  it('does not send a whitespace-only message on click, and reveals the message', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(message(), '   ')
    await user.click(sendButton())
    expect(posts()).toBe(0)
    expectMessageShown(sendButton())
  })

  it('does not send a whitespace-only message on Cmd+Enter', () => {
    renderModal()
    fireEvent.change(message(), { target: { value: '   ' } })
    fireEvent.keyDown(message(), { key: 'Enter', metaKey: true })
    expect(posts()).toBe(0)
  })
})

describe('FeedbackModal: markers', () => {
  it('shows no "* Required" legend and no asterisk on the single input', () => {
    renderModal()
    expect(screen.queryByText('Required')).not.toBeInTheDocument()
    expect(document.querySelector('label[for="feedback-message"]')!.textContent).toBe('Your message')
    expect(document.body.textContent).not.toContain('*')
  })

  it('keeps aria-required on the message and an asterisk-free accessible name', () => {
    renderModal()
    expect(message()).toHaveAttribute('aria-required', 'true')
    expect(message()).toHaveAccessibleName('Your message')
  })
})

describe('FeedbackModal: once filled, and other disabled reasons', () => {
  it('enables Send once a message is typed, with no message on hover, and sends on click', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.type(message(), 'Hello')
    expect(sendButton()).toBeEnabled()
    expect(sendButton()).not.toHaveAttribute('aria-disabled')
    await user.hover(sendButton())
    expectMessageHidden(sendButton())
    await user.click(sendButton())
    await waitFor(() => expect(posts()).toBe(1))
  })

  it('hides a shown message once a message is typed', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.hover(sendButton())
    expectMessageShown(sendButton())
    fireEvent.change(message(), { target: { value: 'Hello' } })
    expectMessageHidden(sendButton())
  })

  it('shows no message while sending: the button is natively disabled', async () => {
    let release: () => void = () => {}
    apiFetchMock.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    renderModal()
    fireEvent.change(message(), { target: { value: 'Hello' } })
    fireEvent.click(sendButton())
    const busy = await screen.findByRole('button', { name: /sending/i })
    expect(busy).toBeDisabled()
    expect(busy).not.toHaveAttribute('aria-disabled')
    fireEvent.mouseEnter(busy)
    fireEvent.focus(busy)
    expectMessageHidden(busy)
    await act(async () => { release() })
    await waitFor(() => expect(screen.getByText(/feedback sent/i)).toBeInTheDocument())
  })

  it('shows no message once feedback is sent', async () => {
    renderModal()
    fireEvent.change(message(), { target: { value: 'Hello' } })
    fireEvent.click(sendButton())
    await screen.findByText(/feedback sent/i)
    expect(gateMessage()).toBeNull()
  })
})
