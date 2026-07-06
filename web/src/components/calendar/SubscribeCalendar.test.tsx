import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    webcalUrl: 'webcal://x/feed.ics', feedUrl: 'https://x/feed.ics', googleUrl: 'https://google/x',
  }),
}))

import { SubscribeCalendar } from './SubscribeCalendar'

describe('SubscribeCalendar', () => {
  beforeEach(() => vi.clearAllMocks())
  it('shows one button that opens a popover with the three actions', async () => {
    render(<SubscribeCalendar />)
    const btn = await screen.findByRole('button', { name: /subscribe/i })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText(/calendar app/i)).toBeInTheDocument())
    expect(screen.getByText(/google calendar/i)).toBeInTheDocument()
    expect(screen.getByText(/copy feed url/i)).toBeInTheDocument()
  })
})
