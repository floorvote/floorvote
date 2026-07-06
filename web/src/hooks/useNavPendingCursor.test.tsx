import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

// The hook reads the data router's navigation state and toggles the
// body.nav-pending wait-cursor class. Mock the hook so we can drive the state.
let navState: 'idle' | 'loading' | 'submitting' = 'idle'
vi.mock('react-router-dom', () => ({
  useNavigation: () => ({ state: navState }),
}))

import { useNavPendingCursor } from './useNavPendingCursor'

function Probe() { useNavPendingCursor(); return null }

beforeEach(() => {
  navState = 'idle'
  document.body.classList.remove('nav-pending')
})

describe('useNavPendingCursor', () => {
  it('adds nav-pending while the router is navigating and removes it when idle', async () => {
    const { rerender } = render(<Probe />)
    expect(document.body.classList.contains('nav-pending')).toBe(false)

    navState = 'loading'
    await act(async () => { rerender(<Probe />) })
    expect(document.body.classList.contains('nav-pending')).toBe(true)

    navState = 'idle'
    await act(async () => { rerender(<Probe />) })
    expect(document.body.classList.contains('nav-pending')).toBe(false)
  })

  it('clears nav-pending on unmount even if a navigation was in flight', async () => {
    navState = 'loading'
    const { unmount } = render(<Probe />)
    expect(document.body.classList.contains('nav-pending')).toBe(true)
    act(() => { unmount() })
    expect(document.body.classList.contains('nav-pending')).toBe(false)
  })
})
