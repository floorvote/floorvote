import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import * as api from '../../lib/api'

function mockConfig(over: Record<string, unknown> = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/config' && (!init || init.method === undefined)) {
      return { modules: { 'email-digest': { enabled: true, settings: { frequency: 'daily' } } }, mention_emails_enabled: true, ...over } as never
    }
    return {} as never
  })
}

describe('Notifications page', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the bill-activity digest and mention email controls', async () => {
    mockConfig()
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    expect(await screen.findByText(/digest of recent bill activity/i)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /conversation emails/i })).toBeInTheDocument()
  })

  it('names the switch "Conversation emails", not "@-mention emails", and says it covers mentions and replies for the whole instance', async () => {
    mockConfig()
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    expect(await screen.findByText('Send conversation emails to members')).toBeInTheDocument()
    expect(screen.queryByText(/@-mention emails/i)).not.toBeInTheDocument()
    expect(screen.getByText(/mentions of a member, a role, @admins, or @everyone in comments, and replies on bills members have commented on, for the whole instance/i)).toBeInTheDocument()
  })

  it('frames the page as settings for everyone in the instance', async () => {
    mockConfig()
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    expect(await screen.findByText(/everyone in the instance/i)).toBeInTheDocument()
  })

  it('stores the conversation switch under the existing mention_emails_enabled key', async () => {
    mockConfig()
    const spy = vi.spyOn(api, 'apiFetch')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('switch', { name: /conversation emails/i }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/admin/config', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ mention_emails_enabled: false }) })))
  })

  it('toggling mention emails OFF confirms first (browser confirm), then PUTs', async () => {
    mockConfig()
    const spy = vi.spyOn(api, 'apiFetch')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name: /conversation/i })
    fireEvent.click(sw)
    expect(confirmSpy).toHaveBeenCalled()
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/admin/config', expect.objectContaining({ method: 'PUT' })))
  })

  it('cancelling the OFF confirm does not PUT', async () => {
    mockConfig()
    const spy = vi.spyOn(api, 'apiFetch')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name: /conversation/i })
    fireEvent.click(sw)
    expect(spy).not.toHaveBeenCalledWith('/admin/config', expect.objectContaining({ method: 'PUT' }))
  })

  it('toggling a setting ON applies immediately (no confirm)', async () => {
    mockConfig({ mention_emails_enabled: false })
    const spy = vi.spyOn(api, 'apiFetch')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name: /conversation/i })
    fireEvent.click(sw)
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/admin/config', expect.objectContaining({ method: 'PUT' })))
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('exposes exactly one top-level heading, for the "Email notifications" title', async () => {
    mockConfig()
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await screen.findByText(/digest of recent bill activity/i)
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Email notifications')
  })
})
