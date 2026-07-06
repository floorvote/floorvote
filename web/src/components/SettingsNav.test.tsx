import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsNav } from './SettingsNav'
import * as AuthContext from '../context/AuthContext'

describe('SettingsNav', () => {
  it('shows a Notifications tab and no Modules tab', () => {
    vi.spyOn(AuthContext, 'useAuth').mockReturnValue({
      user: { id: '1', email: 'a@b.com', name: 'Admin', role: 'admin', subtitle: null, canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null },
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
})
