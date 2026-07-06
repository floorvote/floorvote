import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolling } from './usePolling'

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls fetchFn after intervalMs', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined)
    renderHook(() => usePolling(fetchFn, 1000))
    expect(fetchFn).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('skips a tick when previous fetch is still in flight', async () => {
    let resolve!: () => void
    const fetchFn = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r }))
    renderHook(() => usePolling(fetchFn, 1000))
    await act(async () => { vi.advanceTimersByTime(1000) }) // first tick starts
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1000) }) // second tick — in flight, skipped
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve()
      await Promise.resolve() // flush microtasks so finally block clears inFlight
      vi.advanceTimersByTime(1000) // third tick fires now that inFlight is false
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('pauses interval when tab becomes hidden', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined)
    renderHook(() => usePolling(fetchFn, 1000))
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(fetchFn).toHaveBeenCalledTimes(0)
  })

  it('fires a catch-up fetch when tab becomes visible after long absence', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined)
    renderHook(() => usePolling(fetchFn, 1000))
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(2000) // hidden longer than interval
    })
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchFn).toHaveBeenCalledTimes(1) // catch-up
  })

  it('does NOT fire catch-up when tab was hidden shorter than the interval', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined)
    renderHook(() => usePolling(fetchFn, 5000))
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(1000) // hidden less than interval
    })
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchFn).toHaveBeenCalledTimes(0) // no catch-up
  })

  it('forceRefresh fires fetchFn immediately and resets timer', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => usePolling(fetchFn, 1000))
    await act(async () => { result.current.forceRefresh() })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // After forceRefresh, next tick should be a full interval away
    await act(async () => { vi.advanceTimersByTime(999) })
    expect(fetchFn).toHaveBeenCalledTimes(1) // not yet
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('cleans up interval on unmount', async () => {
    const fetchFn = vi.fn().mockResolvedValue(undefined)
    const { unmount } = renderHook(() => usePolling(fetchFn, 1000))
    unmount()
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(fetchFn).toHaveBeenCalledTimes(0)
  })
})
