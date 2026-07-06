import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBillSort } from './useBillSort'

function makeParams(qs = ''): URLSearchParams {
  return new URLSearchParams(qs)
}

describe('useBillSort', () => {
  it('seeds default/asc when no params', () => {
    const { result } = renderHook(() => useBillSort(makeParams()))
    expect(result.current.sortCol).toBe('default')
    expect(result.current.sortDir).toBe('asc')
  })

  it('seeds from searchParams', () => {
    const { result } = renderHook(() => useBillSort(makeParams('sort=priority&dir=desc')))
    expect(result.current.sortCol).toBe('priority')
    expect(result.current.sortDir).toBe('desc')
  })

  it('toggles dir on same-column click', () => {
    const { result } = renderHook(() => useBillSort(makeParams('sort=status&dir=desc')))
    act(() => result.current.handleSort('status'))
    expect(result.current.sortDir).toBe('asc')
  })

  it('new column uses natural dir (bill→asc, others→desc)', () => {
    const { result } = renderHook(() => useBillSort(makeParams()))
    act(() => result.current.handleSort('priority'))
    expect(result.current.sortCol).toBe('priority')
    expect(result.current.sortDir).toBe('desc')
    act(() => result.current.handleSort('bill'))
    expect(result.current.sortCol).toBe('bill')
    expect(result.current.sortDir).toBe('asc')
  })

  it('handleReset returns to default/asc', () => {
    const { result } = renderHook(() => useBillSort(makeParams('sort=year&dir=desc')))
    act(() => result.current.handleReset())
    expect(result.current.sortCol).toBe('default')
    expect(result.current.sortDir).toBe('asc')
  })
})
