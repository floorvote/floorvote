import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import * as api from '../../lib/api'
import * as AuthContext from '../../context/AuthContext'
import { ConfigContext } from '../../context/ConfigContext'
import { settingBox, SETTING_BOX_TITLE } from '../../lib/settingBoxStyle'

function mockConfig(over: Record<string, unknown> = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/config' && (!init || init.method === undefined)) {
      return { modules: { 'email-digest': { enabled: true, settings: { frequency: 'daily' } } }, mention_emails_enabled: true, ...over } as never
    }
    return {} as never
  })
}

function mockAdminUser() {
  vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
    user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', title: null, canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null, isLastOwner: false, termsAcceptanceRequired: false, termsAcceptanceKind: 'existing_member' as const },
    loading: false, authError: false, authProgress: { current: null },
    setTitle: vi.fn(), setName: vi.fn(),
    setEmailDigestEnabled: vi.fn(), setEmailDigestMatchesEnabled: vi.fn(), setEmailRepliesEnabled: vi.fn(),
    setLastSeenFeed: vi.fn(), setTermsAccepted: vi.fn(), clearUser: vi.fn(),
  })
}

function renderPage(orgNoun?: string) {
  mockConfig()
  mockAdminUser()
  return render(
    <ConfigContext value={{ config: { states: ['DC'], ...(orgNoun === undefined ? {} : { orgNoun }) }, multiState: false, loading: false }}>
      <MemoryRouter initialEntries={['/admin/notifications']}><Notifications /></MemoryRouter>
    </ConfigContext>,
  )
}

describe('Notifications page', () => {
  beforeEach(() => { vi.restoreAllMocks(); document.title = 'FloorVote' })

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

  it('lists the switches in the Account page\'s order: recent activity, upcoming hearings, then conversation emails last', async () => {
    mockConfig()
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await screen.findByText(/digest of recent bill activity/i)
    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual([
      'Toggle email digest',
      'Toggle week-ahead email',
      'Toggle conversation emails',
    ])
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

  it('exposes exactly one top-level heading, for the default "Team notifications" title', async () => {
    mockConfig()
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    await screen.findByText(/digest of recent bill activity/i)
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Team notifications')
  })

  it('boxes each switch with the shared setting-box styles', async () => {
    mockConfig()
    render(<MemoryRouter><Notifications /></MemoryRouter>)
    const sw = await screen.findByRole('switch', { name: /conversation emails/i })
    const styleOf = (el: React.ReactElement) => render(el).container.firstElementChild!.getAttribute('style')
    const box = sw.closest('[style*="12px 14px"]') as HTMLElement
    expect(box).not.toBeNull()
    expect(box.getAttribute('style')).toBe(styleOf(<div style={settingBox(false)} />))
    const title = screen.getByText('Send conversation emails to members')
    expect(title.getAttribute('style')).toBe(styleOf(<div style={SETTING_BOX_TITLE} />))
  })

  describe('named after the org noun', () => {
    it('headline reads "Association notifications" for a configured noun', async () => {
      renderPage('association')
      await screen.findByText(/digest of recent bill activity/i)
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Association notifications$/)
    })

    it('headline uses the default noun when none is configured', async () => {
      renderPage(undefined)
      await screen.findByText(/digest of recent bill activity/i)
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Team notifications$/)
    })

    it('headline no longer reads "Email notifications"', async () => {
      renderPage('association')
      await screen.findByText(/digest of recent bill activity/i)
      expect(screen.queryByRole('heading', { name: 'Email notifications' })).not.toBeInTheDocument()
    })

    it('capitalizes only the first word: a lowercase noun gains a capital and "notifications" stays lowercase', async () => {
      renderPage('chapter')
      await screen.findByText(/digest of recent bill activity/i)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chapter notifications')
    })

    it('normalizes a noun with a capital in the middle to lowercase before capitalizing the first letter', async () => {
      renderPage('cOaLiTiOn')
      await screen.findByText(/digest of recent bill activity/i)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Coalition notifications')
    })

    it('keeps only the first word of a multi-word noun', async () => {
      renderPage('Chapter Office')
      await screen.findByText(/digest of recent bill activity/i)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Chapter notifications')
    })

    it('sets the page title to match, followed by the product name', async () => {
      renderPage('association')
      await screen.findByText(/digest of recent bill activity/i)
      expect(document.title).toBe('Association notifications | FloorVote')
    })

    it('uses the default noun in the page title when none is configured', async () => {
      renderPage(undefined)
      await screen.findByText(/digest of recent bill activity/i)
      expect(document.title).toBe('Team notifications | FloorVote')
    })

    it('restores the previous document title on unmount', async () => {
      const { unmount } = renderPage('association')
      await screen.findByText(/digest of recent bill activity/i)
      unmount()
      expect(document.title).toBe('FloorVote')
    })

    it('shows the same name on the settings tab and the heading, with the tab current and the route unchanged', async () => {
      renderPage('association')
      await screen.findByText(/digest of recent bill activity/i)
      const tab = screen.getByRole('link', { name: 'Association notifications' })
      expect(tab).toHaveAttribute('href', '/admin/notifications')
      expect(tab).toHaveAttribute('aria-current', 'page')
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(tab.textContent ?? '')
    })

    it('leaves the behavior unchanged: the conversation switch still PUTs mention_emails_enabled', async () => {
      renderPage('association')
      const spy = vi.spyOn(api, 'apiFetch')
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      fireEvent.click(await screen.findByRole('switch', { name: /conversation emails/i }))
      await waitFor(() => expect(spy).toHaveBeenCalledWith('/admin/config', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ mention_emails_enabled: false }) })))
    })
  })
})
