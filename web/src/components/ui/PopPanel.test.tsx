import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRef, createRef } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { PopPanel, type PopPanelHandle } from './PopPanel'

const basePos = { position: 'fixed' as const, left: 10, top: 20, width: 300 }

function Harness({ onClose }: { onClose: () => void }) {
  const ref = useRef<PopPanelHandle>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={triggerRef} onClick={() => ref.current?.close()}>trigger</button>
      <PopPanel ref={ref} onClose={onClose} positionStyle={{ position: 'fixed', top: 10, left: 10 }} transformOrigin="top left" triggerRef={triggerRef} ariaLabel="Test panel">
        <div>panel body</div>
        <button>inside</button>
      </PopPanel>
    </div>
  )
}

describe('PopPanel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('renders children and becomes visible after a frame', () => {
    render(<Harness onClose={vi.fn()} />)
    expect(screen.getByText('panel body')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(20) }) // flush requestAnimationFrame shim
    const panel = screen.getByRole('dialog', { name: 'Test panel' })
    expect(panel.style.opacity).toBe('1')
  })

  it('imperative close() fires onClose after the exit timeout', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    act(() => { vi.advanceTimersByTime(20) })
    fireEvent.click(screen.getByText('trigger'))
    expect(onClose).not.toHaveBeenCalled() // still animating out
    act(() => { vi.advanceTimersByTime(300) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    act(() => { vi.advanceTimersByTime(20) })
    fireEvent.keyDown(window, { key: 'Escape' })
    act(() => { vi.advanceTimersByTime(300) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('outside pointerdown closes, but a pointerdown on the trigger does not', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    act(() => { vi.advanceTimersByTime(20) })
    // pointerdown on the trigger is excluded
    fireEvent.pointerDown(screen.getByText('trigger'))
    act(() => { vi.advanceTimersByTime(300) })
    expect(onClose).not.toHaveBeenCalled()
    // pointerdown elsewhere closes
    fireEvent.pointerDown(document.body)
    act(() => { vi.advanceTimersByTime(300) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('PopPanel default (scale-spring) mode', () => {
  it('renders a portaled dialog with a transform-scale style (unchanged default)', () => {
    render(
      <PopPanel onClose={vi.fn()} positionStyle={basePos} transformOrigin="top left">
        <div>body</div>
      </PopPanel>,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg).toBeTruthy()
    expect(dlg.style.transform).toContain('scale(')
  })
})

describe('PopPanel expand mode', () => {
  it('renders the dialog and does not throw when expandFrom + computeTarget are given', () => {
    const ref = createRef<PopPanelHandle>()
    const expandFrom = { left: 50, top: 60, width: 130, height: 46 } as DOMRect
    const computeTarget = (h: number) => ({ left: 50, top: 60, width: 320, height: h })
    render(
      <PopPanel
        ref={ref}
        onClose={vi.fn()}
        positionStyle={basePos}
        transformOrigin="top left"
        expandFrom={expandFrom}
        computeTarget={computeTarget}
      >
        <div>body</div>
      </PopPanel>,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg).toBeTruthy()
    expect(dlg.style.left).not.toBe('')
  })
})

describe('PopPanel cornerRadius', () => {
  it('uses cornerRadius when provided', () => {
    render(
      <PopPanel onClose={vi.fn()} positionStyle={{ position: 'fixed', left: 10, top: 20, width: 320 }} transformOrigin="top left" cornerRadius={6}>
        <div>body</div>
      </PopPanel>,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg.style.borderRadius).toBe('6px')
  })

  it('defaults to the large radius (12) when cornerRadius is unset', () => {
    render(
      <PopPanel onClose={vi.fn()} positionStyle={{ position: 'fixed', left: 10, top: 20, width: 300 }} transformOrigin="top left">
        <div>body</div>
      </PopPanel>,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg.style.borderRadius).toBe('12px')
  })
})

describe('PopPanel clampPosition (grow) mode', () => {
  it('applies clampPosition to left/top after mount, keeping the scale spring', () => {
    const clampPosition = vi.fn((_h: number) => ({ left: 222, top: 333 }))
    render(
      <PopPanel onClose={vi.fn()} positionStyle={{ position: 'fixed', left: 10, top: 20, width: 320 }} transformOrigin="top left" clampPosition={clampPosition}>
        <div>form body</div>
      </PopPanel>,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(clampPosition).toHaveBeenCalled()
    expect(dlg.style.left).toBe('222px')
    expect(dlg.style.top).toBe('333px')
    expect(dlg.style.transform).toContain('scale(') // still the scale-spring, not FLIP
  })

  it('does nothing special without clampPosition (default unchanged)', () => {
    render(
      <PopPanel onClose={vi.fn()} positionStyle={{ position: 'fixed', left: 10, top: 20, width: 300 }} transformOrigin="top left">
        <div>body</div>
      </PopPanel>,
    )
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg.style.transform).toContain('scale(')
  })
})
