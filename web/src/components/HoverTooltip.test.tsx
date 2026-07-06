import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HoverTooltip } from './HoverTooltip'

describe('HoverTooltip', () => {
  it('hides the bubble until hovered, shows on mouse enter, hides on leave', () => {
    render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
    expect(screen.queryByText('Tip text')).toBeNull()
    fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
    expect(screen.getByText('Tip text')).toBeInTheDocument()
    fireEvent.pointerLeave(screen.getByText('trigger'))
    expect(screen.queryByText('Tip text')).toBeNull()
  })

  it('ignores non-mouse pointers (touch) so a tap does not strand the bubble', () => {
    render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
    fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'touch' })
    expect(screen.queryByText('Tip text')).toBeNull()
  })

  it('renders the bubble into document.body when portal is set', () => {
    const { container } = render(
      <HoverTooltip text="Portaled tip" portal><button>trigger</button></HoverTooltip>,
    )
    fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
    const bubble = screen.getByText('Portaled tip')
    expect(bubble).toBeInTheDocument()
    // The bubble is portaled out of the component's own subtree.
    expect(container.contains(bubble)).toBe(false)
  })

  it('wraps multi-line text when maxWidth is set', () => {
    render(<HoverTooltip text="Wrapping tip" maxWidth={200}><button>trigger</button></HoverTooltip>)
    fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
    const bubble = screen.getByText('Wrapping tip')
    expect(bubble.style.whiteSpace).toBe('normal')
    expect(bubble.style.maxWidth).toBe('200px')
    expect(bubble.style.fontWeight).toBe('normal')
  })

  it('places the bubble centered below the trigger for placement="bottom"', () => {
    render(<HoverTooltip text="Below tip" placement="bottom"><button>trigger</button></HoverTooltip>)
    fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
    const bubble = screen.getByText('Below tip')
    // Centered-below: a horizontal-centering transform, and no upward (-100%) shift.
    expect(bubble.style.transform).toContain('translateX(-50%)')
    expect(bubble.style.transform).not.toContain('-100%')
  })
})
