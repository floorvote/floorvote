import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupOperator } from './GroupOperator'

describe('GroupOperator', () => {
  it('reads AND when matching all', () => {
    render(<GroupOperator matchAny={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: /and/i })).toHaveTextContent('AND')
  })

  it('reads OR when matching any', () => {
    render(<GroupOperator matchAny onToggle={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent('OR')
  })

  // Renamed from "is a real button so the tooltip is keyboard-reachable": that
  // rationale was disproven mid-branch (HoverTooltip only wires up
  // aria-describedby in its `toggletip` branch; the default branch used here
  // renders an aria-hidden bubble, so a real <button> does nothing for tooltip
  // reachability). The actual reason it must be a real, operable <button> is
  // that it's a toggle control — native activation via click/Enter/Space, and
  // aria-pressed to expose its on/off state to assistive tech.
  it('is a real, operable toggle button (native activation, aria-pressed)', () => {
    render(<GroupOperator matchAny={false} onToggle={vi.fn()} />)
    const button = screen.getByRole('button')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles on click', () => {
    const onToggle = vi.fn()
    render(<GroupOperator matchAny={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  // Renamed from "states the scope boundary in its tooltip": the visual
  // bubble this asserts against is rendered `aria-hidden` (HoverTooltip is
  // used here without `toggletip`), so this only proves the text is present
  // for a sighted mouse/keyboard user, not that it reaches assistive tech.
  it('shows the scope boundary in its visual (sighted-user) tooltip', async () => {
    render(<GroupOperator matchAny={false} onToggle={vi.fn()} />)
    fireEvent.focus(screen.getByRole('button'))
    expect(await screen.findByText(/always narrow/i)).toBeInTheDocument()
  })

  // The accessible name is the actual accessibility mechanism (the tooltip
  // bubble is aria-hidden and unreachable by touch or screen reader — see
  // GroupOperator.tsx), so it alone must carry the scope boundary and the
  // current/target state.
  it('carries the scope boundary and current state in its accessible name', () => {
    render(<GroupOperator matchAny={false} onToggle={vi.fn()} />)
    const button = screen.getByRole('button')
    expect(button).toHaveAccessibleName(/not yet voted/i)
    expect(button).toHaveAccessibleName(/AND/)
  })

  it('is a native submit-less button and reports its pressed state', () => {
    const { rerender } = render(<GroupOperator matchAny={false} onToggle={vi.fn()} />)
    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('aria-pressed', 'false')

    rerender(<GroupOperator matchAny onToggle={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  })
})
