import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  describe('default mode (toggletip=false) — interactive-element tooltip', () => {
    it('keeps the wrapper a plain span, not a button — structure unchanged for existing consumers', () => {
      render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
      const trigger = screen.getByRole('button', { name: 'trigger' })
      // Exactly one button in the tree: the child. The wrapper is not a second button.
      expect(screen.getAllByRole('button')).toHaveLength(1)
      expect(trigger.parentElement?.tagName.toLowerCase()).toBe('span')
    })

    it('reveals the bubble when the focusable child receives focus, and hides it on blur', async () => {
      const user = userEvent.setup()
      render(
        <>
          <HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>
          <button>next</button>
        </>,
      )
      expect(screen.queryByText('Tip text')).toBeNull()
      await user.tab() // focus "trigger"
      expect(screen.getByText('Tip text')).toBeInTheDocument()
      await user.tab() // focus "next" — blurs "trigger"
      expect(screen.queryByText('Tip text')).toBeNull()
    })

    it('marks the bubble aria-hidden — the child carries its own accessible name', () => {
      render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      const bubble = screen.getByText('Tip text')
      expect(bubble.getAttribute('aria-hidden')).toBe('true')
      expect(bubble.getAttribute('role')).toBeNull()
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('reveals on focus for a non-button interactive child (e.g. a link) too', async () => {
      const user = userEvent.setup()
      render(
        <HoverTooltip text="5 new bills awaiting a priority decision">
          <a href="/bills?newMatches=1" aria-label="5 new bills awaiting a priority decision">5 new</a>
        </HoverTooltip>,
      )
      expect(screen.queryByRole('button')).toBeNull() // the link stays the only control
      await user.tab()
      expect(screen.getByRole('link')).toHaveFocus()
      expect(screen.getByText(/awaiting a priority decision/)).toBeInTheDocument()
    })
  })

  describe('toggletip mode (toggletip=true) — standalone toggletip for non-interactive triggers', () => {
    it('renders the trigger as a button and toggles the bubble on click, wiring aria-describedby', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip toggletip text="Scored 1–10 by AI">i</HoverTooltip>)
      const trigger = screen.getByRole('button')
      expect(screen.queryByRole('tooltip')).toBeNull()

      await user.click(trigger)
      const tip = screen.getByRole('tooltip')
      expect(trigger.getAttribute('aria-describedby')).toBe(tip.id)

      await user.click(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('hides the bubble on Escape', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip toggletip text="Scored 1–10 by AI">i</HoverTooltip>)
      await user.click(screen.getByRole('button'))
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('reveals on keyboard focus and hides on blur', async () => {
      const user = userEvent.setup()
      render(
        <>
          <HoverTooltip toggletip text="Scored 1–10 by AI">i</HoverTooltip>
          <button>next</button>
        </>,
      )
      await user.tab() // focus the toggletip button
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      await user.tab() // focus "next" — blurs the toggletip button
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('still reveals on mouse hover', () => {
      render(<HoverTooltip toggletip text="Scored 1–10 by AI">i</HoverTooltip>)
      const trigger = screen.getByRole('button')
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      fireEvent.pointerLeave(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()
    })
  })
})
