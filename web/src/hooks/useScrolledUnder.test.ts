import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useScrolledUnder } from './useScrolledUnder'

function makeScroller(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

afterEach(() => { document.body.innerHTML = '' })

describe('useScrolledUnder', () => {
  it('is false at the top and true once the container is scrolled', () => {
    const el = makeScroller()
    const { result } = renderHook(() => useScrolledUnder(() => el))
    expect(result.current).toBe(false)
    act(() => {
      Object.defineProperty(el, 'scrollTop', { configurable: true, value: 50 })
      el.dispatchEvent(new Event('scroll'))
    })
    expect(result.current).toBe(true)
  })

  it('returns false when the scroller is not available', () => {
    const { result } = renderHook(() => useScrolledUnder(() => null))
    expect(result.current).toBe(false)
  })
})
