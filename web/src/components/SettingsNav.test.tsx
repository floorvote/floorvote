import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsNav } from './SettingsNav'
import * as AuthContext from '../context/AuthContext'
import { ConfigContext, type AppConfig } from '../context/ConfigContext'

function mockAdminUser() {
  vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
    user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', title: null, canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null, isLastOwner: false, termsAcceptanceRequired: false, termsAcceptanceKind: 'existing_member' as const },
    loading: false,
    authError: false,
    authProgress: { current: null },
    setTitle: vi.fn(),
    setName: vi.fn(),
    setEmailDigestEnabled: vi.fn(), setEmailDigestMatchesEnabled: vi.fn(), setEmailRepliesEnabled: vi.fn(),
    setLastSeenFeed: vi.fn(),
    setTermsAccepted: vi.fn(),
    clearUser: vi.fn(),
  })
}

// jsdom never lays out real scroll metrics (scrollWidth/clientWidth always read
// 0), so scroll-affordance behavior has to be driven by stubbing those
// read-only layout properties directly on the nav element.
function stubScrollMetrics(nav: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
  Object.defineProperty(nav, 'scrollWidth', { value: scrollWidth, configurable: true })
  Object.defineProperty(nav, 'clientWidth', { value: clientWidth, configurable: true })
  Object.defineProperty(nav, 'scrollLeft', { value: scrollLeft, configurable: true, writable: true })
}

describe('SettingsNav', () => {
  it('shows a Team notifications tab (the default org noun) and no Modules tab', () => {
    vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
      user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', title: null, canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null, isLastOwner: false, termsAcceptanceRequired: false, termsAcceptanceKind: 'existing_member' as const },
      loading: false,
      authError: false,
      authProgress: { current: null },
      setTitle: vi.fn(),
      setName: vi.fn(),
      setEmailDigestEnabled: vi.fn(), setEmailDigestMatchesEnabled: vi.fn(), setEmailRepliesEnabled: vi.fn(),
      setLastSeenFeed: vi.fn(),
    setTermsAccepted: vi.fn(),
    clearUser: vi.fn(),
    })
    render(<MemoryRouter><SettingsNav /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Team notifications' })).toHaveAttribute('href', '/admin/notifications')
    expect(screen.queryByRole('link', { name: 'Modules' })).not.toBeInTheDocument()
  })

  it('orders admin tabs Account, Config, Members, Team notifications, Draft bills and drops the pipe divider', () => {
    vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
      user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', title: null, canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null, isLastOwner: false, termsAcceptanceRequired: false, termsAcceptanceKind: 'existing_member' as const },
      loading: false,
      authError: false,
      authProgress: { current: null },
      setTitle: vi.fn(),
      setName: vi.fn(),
      setEmailDigestEnabled: vi.fn(), setEmailDigestMatchesEnabled: vi.fn(), setEmailRepliesEnabled: vi.fn(),
      setLastSeenFeed: vi.fn(),
    setTermsAccepted: vi.fn(),
    clearUser: vi.fn(),
    })
    const { container } = render(<MemoryRouter><SettingsNav /></MemoryRouter>)

    const links = screen.getAllByRole('link')
    expect(links.map((el) => el.textContent)).toEqual([
      'Account',
      'Config',
      'Members',
      'Team notifications',
      'Draft bills',
    ])

    expect(screen.getByRole('link', { name: 'Draft bills' })).toHaveAttribute('href', '/admin/drafts')

    // The vertical pipe divider before "Admin" has been removed.
    const nav = container.querySelector('nav.settings-nav')
    const pipe = Array.from(nav?.children ?? []).find(
      (el) => el.tagName === 'DIV' && (el as HTMLElement).style.width === '1px',
    )
    expect(pipe).toBeUndefined()
  })

  it('locks vertical scroll on the tab row so only horizontal scrolling is possible', () => {
    mockAdminUser()
    const { container } = render(<MemoryRouter><SettingsNav /></MemoryRouter>)
    const nav = container.querySelector('nav.settings-nav') as HTMLElement

    // overflow-x stays scrollable; overflow-y must NOT be 'auto' (or 'visible',
    // which the CSS spec would force to 'auto' anyway) — otherwise a non-visible
    // overflow-x forces a scrollable overflow-y too, letting the row scroll
    // vertically as well as horizontally.
    expect(nav.style.overflowX).toBe('auto')
    expect(['hidden', 'clip']).toContain(nav.style.overflowY)

    // overflow-clip-margin is a no-op under overflow-y: hidden — it only takes
    // effect for 'clip' — so this only guards the ring when 'clip' is in use.
    // Pins the margin to a real, static inline style so a future swap to
    // 'hidden', or a shrunk/removed margin, fails a test instead of silently
    // re-clipping the focused tab's outline ring (2px + 2px offset = 4px).
    if (nav.style.overflowY === 'clip') {
      expect(parseFloat(nav.style.overflowClipMargin)).toBeGreaterThanOrEqual(4)
    }
  })

  it('shows a right-edge fade when the tab row overflows and there is more to scroll', () => {
    mockAdminUser()
    const { container } = render(<MemoryRouter><SettingsNav /></MemoryRouter>)
    const nav = container.querySelector('nav.settings-nav') as HTMLElement
    const rightFade = container.querySelector('[data-testid="settings-nav-fade-right"]') as HTMLElement

    // Desktop-like: no overflow at all — fade absent.
    act(() => {
      stubScrollMetrics(nav, { scrollWidth: 400, clientWidth: 400, scrollLeft: 0 })
      fireEvent.scroll(nav)
    })
    expect(rightFade.style.opacity).toBe('0')

    // Overflowing and scrolled to the start — more content to the right.
    act(() => {
      stubScrollMetrics(nav, { scrollWidth: 600, clientWidth: 400, scrollLeft: 0 })
      fireEvent.scroll(nav)
    })
    expect(rightFade.style.opacity).toBe('1')

    // Scrolled all the way to the end — right fade hides.
    act(() => {
      stubScrollMetrics(nav, { scrollWidth: 600, clientWidth: 400, scrollLeft: 200 })
      fireEvent.scroll(nav)
    })
    expect(rightFade.style.opacity).toBe('0')
  })

  it('shows a left-edge fade only once the tab row has scrolled away from the start', () => {
    mockAdminUser()
    const { container } = render(<MemoryRouter><SettingsNav /></MemoryRouter>)
    const nav = container.querySelector('nav.settings-nav') as HTMLElement
    const leftFade = container.querySelector('[data-testid="settings-nav-fade-left"]') as HTMLElement

    act(() => {
      stubScrollMetrics(nav, { scrollWidth: 600, clientWidth: 400, scrollLeft: 0 })
      fireEvent.scroll(nav)
    })
    expect(leftFade.style.opacity).toBe('0')

    act(() => {
      stubScrollMetrics(nav, { scrollWidth: 600, clientWidth: 400, scrollLeft: 120 })
      fireEvent.scroll(nav)
    })
    expect(leftFade.style.opacity).toBe('1')
  })

  it('does not let the fade overlays intercept tab clicks', () => {
    mockAdminUser()
    const { container } = render(<MemoryRouter><SettingsNav /></MemoryRouter>)
    const rightFade = container.querySelector('[data-testid="settings-nav-fade-right"]') as HTMLElement
    const leftFade = container.querySelector('[data-testid="settings-nav-fade-left"]') as HTMLElement

    expect(rightFade.style.pointerEvents).toBe('none')
    expect(leftFade.style.pointerEvents).toBe('none')
    expect(rightFade.getAttribute('aria-hidden')).toBe('true')
    expect(leftFade.getAttribute('aria-hidden')).toBe('true')
  })

  it('offers Calendar events only while a covered state has body events', () => {
    mockAdminUser()
    const withCapabilities = (capabilities: AppConfig['capabilities']) => (
      <ConfigContext value={{ config: { states: ['DC', 'MD'], capabilities }, multiState: true, loading: false }}>
        <MemoryRouter><SettingsNav /></MemoryRouter>
      </ConfigContext>
    )
    const { rerender } = render(withCapabilities({ MD: { bodyEvents: false, deadlines: true } }))
    expect(screen.queryByRole('link', { name: 'Calendar events' })).not.toBeInTheDocument()
    rerender(withCapabilities({ DC: { bodyEvents: true, deadlines: true } }))
    expect(screen.getByRole('link', { name: 'Calendar events' })).toHaveAttribute('href', '/admin/calendar-events')
  })
  describe('admin notifications tab is named after the org noun', () => {
    function renderWithNoun(orgNoun: string | undefined, path = '/admin/config') {
      mockAdminUser()
      return render(
        <ConfigContext value={{ config: { states: ['DC'], ...(orgNoun === undefined ? {} : { orgNoun }) }, multiState: false, loading: false }}>
          <MemoryRouter initialEntries={[path]}><SettingsNav /></MemoryRouter>
        </ConfigContext>,
      )
    }

    it('reads "Association notifications" for a configured noun', () => {
      renderWithNoun('association')
      expect(screen.getByRole('link', { name: 'Association notifications' })).toHaveAttribute('href', '/admin/notifications')
    })

    it('reads "Coalition notifications" for another configured noun', () => {
      renderWithNoun('coalition')
      expect(screen.getByRole('link', { name: 'Coalition notifications' })).toBeInTheDocument()
    })

    it('uses the default noun when the config has no org noun', () => {
      renderWithNoun(undefined)
      expect(screen.getByRole('link', { name: 'Team notifications' })).toBeInTheDocument()
    })

    it('uses the default noun when the org noun is an empty string', () => {
      renderWithNoun('')
      expect(screen.getByRole('link', { name: 'Team notifications' })).toBeInTheDocument()
    })

    it('uses the default noun while the config has not loaded', () => {
      mockAdminUser()
      render(
        <ConfigContext value={{ config: null, multiState: false, loading: true }}>
          <MemoryRouter><SettingsNav /></MemoryRouter>
        </ConfigContext>,
      )
      expect(screen.getByRole('link', { name: 'Team notifications' })).toBeInTheDocument()
    })

    it('capitalizes only the first word: a noun already in lowercase gains a leading capital and "notifications" stays lowercase', () => {
      renderWithNoun('chapter')
      const link = screen.getByRole('link', { name: 'Chapter notifications' })
      expect(link.textContent).toBe('Chapter notifications')
    })

    it('normalizes a noun with a capital in the middle to lowercase before capitalizing the first letter', () => {
      renderWithNoun('cOaLiTiOn')
      expect(screen.getByRole('link', { name: 'Coalition notifications' })).toBeInTheDocument()
    })

    it('normalizes an all-caps noun the same way', () => {
      renderWithNoun('LEAGUE')
      expect(screen.getByRole('link', { name: 'League notifications' })).toBeInTheDocument()
    })

    it('keeps only the first word of a multi-word noun, so a second word is never capitalized', () => {
      renderWithNoun('Chapter Office')
      expect(screen.getByRole('link', { name: 'Chapter notifications' })).toBeInTheDocument()
    })

    it('no longer shows a bare "Notifications" tab', () => {
      renderWithNoun('association')
      expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument()
    })

    it('keeps the tab in the same slot, between Members and Draft bills', () => {
      renderWithNoun('association')
      expect(screen.getAllByRole('link').map((el) => el.textContent)).toEqual([
        'Account', 'Config', 'Members', 'Association notifications', 'Draft bills',
      ])
    })

    it('keeps the route at /admin/notifications and marks the tab current there', () => {
      renderWithNoun('association', '/admin/notifications')
      const link = screen.getByRole('link', { name: 'Association notifications' })
      expect(link).toHaveAttribute('href', '/admin/notifications')
      expect(link).toHaveAttribute('aria-current', 'page')
    })

    it('does not rename the tab for non-admins (they see no admin tabs)', () => {
      vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
        user: { id: '2', email: 'm@b.com', name: 'Member', role: 'member', title: null, canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true, lastSeenFeed: null, isLastOwner: false, termsAcceptanceRequired: false, termsAcceptanceKind: 'existing_member' as const },
        loading: false, authError: false, authProgress: { current: null },
        setTitle: vi.fn(), setName: vi.fn(),
        setEmailDigestEnabled: vi.fn(), setEmailDigestMatchesEnabled: vi.fn(), setEmailRepliesEnabled: vi.fn(),
        setLastSeenFeed: vi.fn(), setTermsAccepted: vi.fn(), clearUser: vi.fn(),
      })
      render(
        <ConfigContext value={{ config: { states: ['DC'], orgNoun: 'association' }, multiState: false, loading: false }}>
          <MemoryRouter><SettingsNav /></MemoryRouter>
        </ConfigContext>,
      )
      expect(screen.queryByRole('link', { name: /notifications/i })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Account' })).toBeInTheDocument()
    })
  })
})
