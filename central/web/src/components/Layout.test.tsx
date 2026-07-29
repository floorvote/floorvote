import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ identity: { email: 'admin@example.com' }, logout: vi.fn() }),
}))

import Layout from './Layout'

describe('central Layout', () => {
  it('renders the FloorVote lockup and a Central Admin caption', () => {
    render(<MemoryRouter><Layout /></MemoryRouter>)
    expect(screen.getByText('Floor')).toBeInTheDocument()
    expect(screen.getByText('Vote')).toBeInTheDocument()
    expect(screen.getByText('Central Admin')).toBeInTheDocument()
  })
})
