import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'

// The week-ahead email's footer links /calendar#subscribe, so arriving on that
// hash must land the reader on the open chooser rather than on a page where the
// Subscribe button is one more thing to find.
vi.mock('../../context/DemoContext', () => ({ useDemo: () => ({ demoMode: false, demoLocked: false }) }))
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../ui/PopPanel', () => ({
  PopPanel: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}))
vi.mock('./EventPopover', () => ({
  computeEventPopoverPosition: () => ({ transformOrigin: 'top right', enterOffsetY: 0, positionStyle: {} }),
}))

import { apiFetch } from '../../lib/api'
const mockFetch = vi.mocked(apiFetch)
import { SubscribeCalendar } from './SubscribeCalendar'

const INFO = { webcalUrl: 'webcal://x/f.ics', feedUrl: 'https://x/f.ics', googleUrl: 'https://google/x' }

beforeEach(() => { mockFetch.mockResolvedValue(INFO) })
afterEach(() => { window.location.hash = '' })

describe('SubscribeCalendar #subscribe deep link', () => {
  it('opens the chooser automatically when the page loads on #subscribe', async () => {
    window.location.hash = '#subscribe'
    render(<SubscribeCalendar />)
    await waitFor(() => expect(screen.getByText(/subscribe in your calendar app/i)).toBeInTheDocument())
  })

  it('clears the hash so a reload or a manual close does not re-open it', async () => {
    window.location.hash = '#subscribe'
    render(<SubscribeCalendar />)
    await waitFor(() => expect(screen.getByText(/subscribe in your calendar app/i)).toBeInTheDocument())
    expect(window.location.hash).toBe('')
  })

  it('stays closed without the hash', async () => {
    render(<SubscribeCalendar />)
    await screen.findByRole('button', { name: /^subscribe$/i })
    expect(screen.queryByText(/subscribe in your calendar app/i)).not.toBeInTheDocument()
  })
})
