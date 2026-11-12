// The one retry the Bills page and the split-pane list share after a database overload (503 with Retry-After): the
// delay an error asks for, the request-sequence guard, and the single timer that a new request or an unmount clears.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { ApiError } from '../../lib/api'
import { overloadDelayMs, useOverloadRetry } from './overloadRetry'

afterEach(() => { vi.useRealTimers() })

describe('overloadDelayMs', () => {
  it('is the Retry-After interval for a 503 that names one', () => {
    expect(overloadDelayMs(new ApiError(503, 'database_overloaded', undefined, undefined, 10_000))).toBe(10_000)
  })
  it('is null for a 503 with no interval', () => {
    expect(overloadDelayMs(new ApiError(503, 'database_overloaded'))).toBeNull()
  })
  it('is null for any other status, even with an interval', () => {
    expect(overloadDelayMs(new ApiError(500, 'internal_error', undefined, undefined, 10_000))).toBeNull()
  })
  it('is null for an error that is not an ApiError', () => {
    expect(overloadDelayMs(new Error('boom'))).toBeNull()
    expect(overloadDelayMs(undefined)).toBeNull()
  })
})

describe('useOverloadRetry', () => {
  it('runs the retry once after the interval, and not before', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useOverloadRetry())
    const run = vi.fn()
    const seq = result.current.start()
    result.current.schedule(seq, 10_000, run)
    vi.advanceTimersByTime(9_999)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('numbers requests so only the newest is current', () => {
    const { result } = renderHook(() => useOverloadRetry())
    const a = result.current.start()
    expect(result.current.isCurrent(a)).toBe(true)
    const b = result.current.start()
    expect(b).not.toBe(a)
    expect(result.current.isCurrent(a)).toBe(false)
    expect(result.current.isCurrent(b)).toBe(true)
  })

  it('cancels a pending retry when a newer request starts', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useOverloadRetry())
    const run = vi.fn()
    result.current.schedule(result.current.start(), 10_000, run)
    result.current.start()
    vi.advanceTimersByTime(60_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('arms nothing for a request that is no longer the newest, and leaves the newer one\'s timer alone', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useOverloadRetry())
    const stale = result.current.start()
    const newer = result.current.start()
    const newerRun = vi.fn()
    const staleRun = vi.fn()
    result.current.schedule(newer, 10_000, newerRun)
    result.current.schedule(stale, 5_000, staleRun)
    vi.advanceTimersByTime(60_000)
    expect(staleRun).not.toHaveBeenCalled()
    expect(newerRun).toHaveBeenCalledTimes(1)
  })

  it('clear() cancels the pending retry', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useOverloadRetry())
    const run = vi.fn()
    result.current.schedule(result.current.start(), 10_000, run)
    result.current.clear()
    vi.advanceTimersByTime(60_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('cancels a pending retry on unmount', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() => useOverloadRetry())
    const run = vi.fn()
    result.current.schedule(result.current.start(), 10_000, run)
    unmount()
    vi.advanceTimersByTime(60_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('hands back the same functions on every render, so a callback built on them is not rebuilt', () => {
    const { result, rerender } = renderHook(() => useOverloadRetry())
    const first = result.current
    rerender()
    expect(result.current.start).toBe(first.start)
    expect(result.current.isCurrent).toBe(first.isCurrent)
    expect(result.current.schedule).toBe(first.schedule)
    expect(result.current.clear).toBe(first.clear)
  })
})
