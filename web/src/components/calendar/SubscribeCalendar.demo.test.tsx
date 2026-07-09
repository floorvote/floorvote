import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
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

beforeEach(() => { demo.demoLocked = false; mockFetch.mockResolvedValue(INFO) })

async function openPopover() {
  render(<SubscribeCalendar />)
  const trigger = await screen.findByRole('button', { name: /^subscribe$/i })
  await userEvent.click(trigger)
}

describe('SubscribeCalendar demo gating', () => {
  it('options are live when not demo', async () => {
    await openPopover()
    const webcal = screen.getByText(/subscribe in your calendar app/i).closest('a') as HTMLAnchorElement
    expect(webcal.getAttribute('href')).toBe(INFO.webcalUrl)
    expect(screen.getByRole('button', { name: /copy feed url/i })).not.toBeDisabled()
  })

  it('options are disabled in demo', async () => {
    demo.demoLocked = true
    await openPopover()
    const webcal = screen.getByText(/subscribe in your calendar app/i).closest('a') as HTMLAnchorElement
    const google = screen.getByText(/add to google calendar/i).closest('a') as HTMLAnchorElement
    expect(webcal.getAttribute('href')).toBeNull()
    expect(webcal.getAttribute('aria-disabled')).toBe('true')
    expect(google.getAttribute('href')).toBeNull()
    expect(google.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('button', { name: /copy feed url/i })).toBeDisabled()
  })
})
