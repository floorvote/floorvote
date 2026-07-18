import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsNav } from './SettingsNav'
import * as AuthContext from '../context/AuthContext'

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
})
