import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsNav } from './SettingsNav'
import * as AuthContext from '../context/AuthContext'

function mockAdminUser() {
  vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
    user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', subtitle: null, canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null, isLastOwner: false },
    loading: false,
    authError: false,
    setSubtitle: vi.fn(),
    setName: vi.fn(),
    setEmailDigestEnabled: vi.fn(),
    setLastSeenFeed: vi.fn(),
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
  it('shows a Notifications tab and no Modules tab', () => {
    vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
      user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', subtitle: null, canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null, isLastOwner: false },
      loading: false,
      authError: false,
      setSubtitle: vi.fn(),
      setName: vi.fn(),
      setEmailDigestEnabled: vi.fn(),
      setLastSeenFeed: vi.fn(),
    })
    render(<MemoryRouter><SettingsNav /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute('href', '/admin/notifications')
    expect(screen.queryByRole('link', { name: 'Modules' })).not.toBeInTheDocument()
  })

  it('orders admin tabs Account, Config, Members, Notifications, Draft bills and drops the pipe divider', () => {
    vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
      user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', subtitle: null, canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null, isLastOwner: false },
      loading: false,
      authError: false,
      setSubtitle: vi.fn(),
      setName: vi.fn(),
      setEmailDigestEnabled: vi.fn(),
      setLastSeenFeed: vi.fn(),
    })
    const { container } = render(<MemoryRouter><SettingsNav /></MemoryRouter>)

    const links = screen.getAllByRole('link')
    expect(links.map((el) => el.textContent)).toEqual([
      'Account',
      'Config',
      'Members',
      'Notifications',
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
})
