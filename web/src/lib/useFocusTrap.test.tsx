import { describe, it, expect, vi } from 'vitest'
import { useRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { useFocusTrap } from './useFocusTrap'

function Harness({ active, onEscape }: { active: boolean; onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap({ active, containerRef: ref, onEscape, initialFocus: 'first' })
  return (
    <div>
      <button>outside</button>
      {active && (
        <div ref={ref} data-testid="panel">
          <input aria-label="field" />
          <button>inside</button>
        </div>
      )}
    </div>
  )
}

function NestedHarness({ outerActive, innerActive }: { outerActive: boolean; innerActive: boolean }) {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  useFocusTrap({ active: outerActive, containerRef: outerRef, initialFocus: 'first' })
  useFocusTrap({ active: innerActive, containerRef: innerRef, initialFocus: 'first' })
  return (
    <div>
      <button>outside</button>
      {outerActive && (
        <div ref={outerRef} data-testid="outer">
          <button>outer button</button>
          {innerActive && (
            <div ref={innerRef} data-testid="inner">
              <button>inner button</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable inside the container when activated', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    render(<Harness active />, { container: root })
    expect(document.activeElement).toBe(screen.getByLabelText('field'))
    root.remove()
  })

  it('sets inert + aria-hidden on #root while active and clears it after', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    const { rerender } = render(<Harness active />, { container: root })
    expect(root.hasAttribute('inert')).toBe(true)
    expect(root.getAttribute('aria-hidden')).toBe('true')
    rerender(<Harness active={false} />)
    expect(root.hasAttribute('inert')).toBe(false)
    expect(root.hasAttribute('aria-hidden')).toBe(false)
    root.remove()
  })

  it('calls onEscape when Escape is pressed', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    const onEscape = vi.fn()
    render(<Harness active onEscape={onEscape} />, { container: root })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    root.remove()
  })

  it('restores focus to the previously-focused element on deactivate', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    const trigger = document.createElement('button'); document.body.appendChild(trigger); trigger.focus()
    const { rerender } = render(<Harness active={false} />, { container: root })
    // activate: (trigger currently focused) — simulate by focusing then activating
    trigger.focus()
    rerender(<Harness active />)
    rerender(<Harness active={false} />)
    expect(document.activeElement).toBe(trigger)
    trigger.remove(); root.remove()
  })

  it('ref-counts nested traps: #root stays inert until the last (outer) trap deactivates', () => {
    const root = document.createElement('div'); root.id = 'root'; document.body.appendChild(root)
    const { rerender } = render(<NestedHarness outerActive innerActive />, { container: root })
    expect(root.hasAttribute('inert')).toBe(true)

    // deactivate the inner trap only — outer trap is still active, #root must stay inert
    rerender(<NestedHarness outerActive innerActive={false} />)
    expect(root.hasAttribute('inert')).toBe(true)

    // deactivate the outer trap too — now #root should be released
    rerender(<NestedHarness outerActive={false} innerActive={false} />)
    expect(root.hasAttribute('inert')).toBe(false)

    root.remove()
  })
})
