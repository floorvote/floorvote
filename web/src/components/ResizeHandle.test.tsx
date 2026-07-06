import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVerticalResize } from './ResizeHandle'

function startDrag(handlePointerDown: (e: React.PointerEvent) => void, startY: number) {
  const fakeEvent = { preventDefault: () => {}, clientY: startY } as unknown as React.PointerEvent
  act(() => handlePointerDown(fakeEvent))
}

function move(clientY: number) {
  act(() => {
    document.dispatchEvent(new PointerEvent('pointermove', { clientY, bubbles: true }))
  })
}

function release() {
  act(() => {
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
}

describe('useVerticalResize', () => {
  it('respects minHeight when dragging up', () => {
    const { result } = renderHook(() => useVerticalResize(200, 80))
    startDrag(result.current.handlePointerDown, 200)
    move(50)   // wants to shrink to 50 (200 + (50-200) = 50)
    expect(result.current.height).toBe(80) // clamped to min
    release()
  })

  it('honors getMaxHeight clamp when dragging down', () => {
    let maxAllowed = 250
    const { result } = renderHook(() => useVerticalResize(200, 80, () => maxAllowed))
    startDrag(result.current.handlePointerDown, 200)
    move(500)  // wants to grow by +300 = 500
    expect(result.current.height).toBe(maxAllowed)
    release()
  })

  it('updates getMaxHeight result on each move (sibling-aware clamp)', () => {
    let maxAllowed = 400
    const { result } = renderHook(() => useVerticalResize(200, 80, () => maxAllowed))
    startDrag(result.current.handlePointerDown, 200)
    move(400)  // wants 400
    expect(result.current.height).toBe(400) // within limit
    // Now sibling grows, tightening the budget
    maxAllowed = 300
    move(450)  // wants 450, but clamp says 300
    expect(result.current.height).toBe(300)
    release()
  })

  it('reports hasResized after a move', () => {
    const { result } = renderHook(() => useVerticalResize(200, 80))
    expect(result.current.hasResized).toBe(false)
    startDrag(result.current.handlePointerDown, 200)
    move(250)
    expect(result.current.hasResized).toBe(true)
    release()
  })

  it('exposes setHeight for external clamping', () => {
    const { result } = renderHook(() => useVerticalResize(200, 80))
    act(() => result.current.setHeight(150))
    expect(result.current.height).toBe(150)
  })
})
