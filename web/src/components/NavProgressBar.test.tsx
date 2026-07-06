import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

let navState: 'idle' | 'loading' | 'submitting' = 'idle'
let navLocation: { pathname: string } | undefined = undefined
vi.mock('react-router-dom', () => ({
  useNavigation: () => ({ state: navState, location: navLocation }),
  useLocation: () => ({ pathname: '/' }),
}))

import { NavProgressBar } from './NavProgressBar'

const bar = () => document.querySelector('.nav-progress') as HTMLElement

beforeEach(() => { navState = 'idle'; navLocation = undefined })

describe('NavProgressBar', () => {
  it('starts hidden, shows while navigation is loading, then completes and fades back to hidden', async () => {
    const { rerender } = render(<NavProgressBar />)

    // idle: invisible, zero width
    expect(bar().style.opacity).toBe('0')
    expect(bar().style.transform).toBe('scaleX(0)')

    // navigation begins loading to a DIFFERENT path → active (visible, grown)
    navLocation = { pathname: '/bills' }
    navState = 'loading'
    await act(async () => { rerender(<NavProgressBar />) })
    await waitFor(() => expect(bar().style.opacity).toBe('1'))
    expect(bar().style.transform).toBe('scaleX(0.9)')

    // navigation settles → done (snaps to full width, still visible)
    navState = 'idle'
    await act(async () => { rerender(<NavProgressBar />) })
    await waitFor(() => expect(bar().style.transform).toBe('scaleX(1)'))
    expect(bar().style.opacity).toBe('1')

    // after the hold + fade timers, returns to hidden
    await waitFor(() => expect(bar().style.opacity).toBe('0'), { timeout: 2000 })
  })

  it('stays hidden during same-route param changes (search/filter)', async () => {
    const { rerender } = render(<NavProgressBar />)
    navLocation = { pathname: '/' }
    navState = 'loading'
    await act(async () => { rerender(<NavProgressBar />) })
    expect(bar().style.opacity).toBe('0')
    expect(bar().style.transform).toBe('scaleX(0)')
  })

  it('stays hidden when navigation never leaves idle', async () => {
    const { rerender } = render(<NavProgressBar />)
    navState = 'idle'
    await act(async () => { rerender(<NavProgressBar />) })
    await waitFor(() => expect(bar().style.opacity).toBe('0'))
    expect(bar().style.transform).toBe('scaleX(0)')
  })
})
