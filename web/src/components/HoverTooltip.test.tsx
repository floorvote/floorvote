import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

  // Scrolling moves the thing a tooltip describes. The bubble is position:fixed
  // at coordinates taken when it opened, so it has to be re-anchored or it ends
  // up floating beside whatever is there now.
  describe('following the anchor on scroll', () => {
    // Stub the geometry so a "scroll" can actually move it; jsdom has no layout
    // and reports zeros for everything. Note this stubs the WRAPPER, not the
    // child: HoverTooltip measures the element it puts its own ref on, and the
    // child button is only what the test can conveniently query for.
    const atY = (child: Element, top: number) => {
      const el = child.parentElement as Element
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        top, bottom: top + 20, left: 100, right: 200, width: 100, height: 20,
        x: 100, y: top, toJSON: () => ({}),
      } as DOMRect)
    }

    it('keeps the bubble open across a scroll rather than dismissing it', async () => {
      render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      expect(screen.getByText('Tip text')).toBeInTheDocument()
      fireEvent.scroll(window)
      await waitFor(() => expect(screen.getByText('Tip text')).toBeInTheDocument())
    })

    it('re-anchors the bubble to the anchor’s new position', async () => {
      render(<HoverTooltip text="Tip text" placement="bottom"><button>trigger</button></HoverTooltip>)
      const trigger = screen.getByText('trigger')
      atY(trigger, 400)
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      expect(screen.getByText('Tip text').style.top).toBe('426px')

      // The page scrolls; the anchor is now higher up the viewport.
      atY(trigger, 100)
      fireEvent.scroll(window)
      await waitFor(() => expect(screen.getByText('Tip text').style.top).toBe('126px'))
    })

    // The app scrolls inner containers, and scroll does not bubble to window
    // from those — hence a capture-phase listener.
    it('follows a scroll inside a nested scroll container', async () => {
      const { container } = render(
        <div style={{ overflowY: 'auto' }}>
          <HoverTooltip text="Tip text" placement="bottom"><button>trigger</button></HoverTooltip>
        </div>,
      )
      const trigger = screen.getByText('trigger')
      atY(trigger, 400)
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      atY(trigger, 50)
      fireEvent.scroll(container.firstChild as Element)
      await waitFor(() => expect(screen.getByText('Tip text').style.top).toBe('76px'))
    })

    it('hides once the anchor has scrolled out of the viewport', async () => {
      render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
      const trigger = screen.getByText('trigger')
      atY(trigger, 300)
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      expect(screen.getByText('Tip text')).toBeInTheDocument()

      atY(trigger, -400) // scrolled off the top: bottom < 0
      fireEvent.scroll(window)
      await waitFor(() => expect(screen.queryByText('Tip text')).toBeNull())
    })

    // The failure that sank two dismiss-on-scroll attempts: a scroll makes the
    // browser re-dispatch pointerenter with the cursor unmoved. Re-anchoring is
    // idempotent with that — the re-entry sets the same rect this would have
    // — so the outcome no longer depends on whether it happens.
    it('is unaffected by a scroll-induced pointerenter with no mouse move', async () => {
      render(<HoverTooltip text="Tip text" placement="bottom"><button>trigger</button></HoverTooltip>)
      const trigger = screen.getByText('trigger')
      atY(trigger, 400)
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })

      atY(trigger, 120)
      fireEvent.scroll(window)
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      await waitFor(() => expect(screen.getByText('Tip text').style.top).toBe('146px'))
    })

    it('does not listen while no bubble is open', () => {
      const add = vi.spyOn(window, 'addEventListener')
      render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
      expect(add.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(0)
      add.mockRestore()
    })
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

  // The default is what the bug was about: a caller that says nothing must not
  // be left inline, where any ancestor stacking context caps the bubble's depth
  // and a sticky header paints over it.
  it('portals by default, with no portal prop passed', () => {
    const { container } = render(
      <HoverTooltip text="Default tip"><button>trigger</button></HoverTooltip>,
    )
    fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
    expect(container.contains(screen.getByText('Default tip'))).toBe(false)
  })

  it('still renders inline when portal is explicitly disabled', () => {
    const { container } = render(
      <HoverTooltip text="Inline tip" portal={false}><button>trigger</button></HoverTooltip>,
    )
    fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
    expect(container.contains(screen.getByText('Inline tip'))).toBe(true)
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

    it('still reveals on mouse hover, and a plain (unpinned) hover still closes on leave', () => {
      render(<HoverTooltip toggletip text="Scored 1–10 by AI">i</HoverTooltip>)
      const trigger = screen.getByRole('button')
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
      expect(screen.getByRole('tooltip')).toBeInTheDocument()
      fireEvent.pointerLeave(trigger)
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('a click-pinned bubble survives the mouse leaving, and still closes on Escape', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip toggletip text="Scored 1–10 by AI">i</HoverTooltip>)
      const trigger = screen.getByRole('button')

      await user.click(trigger) // pins the bubble open
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      fireEvent.pointerLeave(trigger) // the toggletip hide contract is Escape/blur/second-click only
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      await user.keyboard('{Escape}')
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('a click-pinned bubble survives the mouse leaving, and still closes on a second click', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip toggletip text="Scored 1–10 by AI">i</HoverTooltip>)
      const trigger = screen.getByRole('button')

      await user.click(trigger) // pins the bubble open
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      fireEvent.pointerLeave(trigger)
      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      await user.click(trigger) // second click un-pins and closes
      expect(screen.queryByRole('tooltip')).toBeNull()
    })
  })
})
