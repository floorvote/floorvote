import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HoverTooltip } from './HoverTooltip'

// jsdom performs no layout, so every element's real getBoundingClientRect()
// is all zeros. Same technique as FilterSheet.test.tsx/FilterPanel.test.tsx
// (stub HTMLElement.prototype geometry, restore the original descriptor
// afterward) — but keyed per-element here, since a single test needs three
// different rects at once: the hover anchor, the rendered bubble (measured
// via HoverTooltip's own ref, not asserted-on logic), and (for the
// boundaryRef case) a clamp boundary element. Elements are told apart by
// identity the test controls: the bubble by its exact text, a boundary
// element by data-testid="boundary", everything else (the anchor wrapper)
// falls through to the anchor rect. This only stubs geometry inputs — the
// clamping/flip arithmetic under test still runs for real.
function rect(r: { left: number; right: number; top?: number; bottom?: number; width?: number; height?: number }): DOMRect {
  const top = r.top ?? 0
  const bottom = r.bottom ?? top + 20
  return {
    left: r.left,
    right: r.right,
    top,
    bottom,
    width: r.width ?? r.right - r.left,
    height: r.height ?? bottom - top,
    x: r.left,
    y: top,
    toJSON() { return this },
  } as DOMRect
}

function stubGeometry({
  innerWidth,
  anchorRect,
  bubbleWidth,
  bubbleText,
  boundaryRect,
}: {
  innerWidth: number
  anchorRect: { left: number; right: number }
  bubbleWidth?: number
  bubbleText?: string
  boundaryRect?: { left: number; right: number }
}) {
  const rectDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')

  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function (this: HTMLElement) {
      if (bubbleText !== undefined && this.textContent === bubbleText) {
        return rect({ left: 0, right: bubbleWidth ?? 0, width: bubbleWidth ?? 0 })
      }
      if (boundaryRect && this.dataset.testid === 'boundary') {
        return rect(boundaryRect)
      }
      return rect(anchorRect)
    },
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth })

  return () => {
    if (rectDescriptor) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', rectDescriptor)
    if (widthDescriptor) Object.defineProperty(window, 'innerWidth', widthDescriptor)
  }
}

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

  // The bubble is position:fixed at coordinates taken once on open, so a scroll
  // moves the thing it describes and leaves the bubble floating beside whatever
  // is there now.
  describe('dismissal on scroll', () => {
    it('dismisses the bubble when the window scrolls', () => {
      render(<HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      expect(screen.getByText('Tip text')).toBeInTheDocument()
      fireEvent.scroll(window)
      expect(screen.queryByText('Tip text')).toBeNull()
    })

    // The app scrolls inner containers rather than the document, and scroll does
    // not bubble from those — hence a capture-phase listener. Firing on a nested
    // element is what distinguishes capture from a plain window listener.
    it('dismisses on a scroll inside a nested scroll container', () => {
      const { container } = render(
        <div style={{ overflowY: 'auto' }}>
          <HoverTooltip text="Tip text"><button>trigger</button></HoverTooltip>
        </div>,
      )
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      expect(screen.getByText('Tip text')).toBeInTheDocument()
      fireEvent.scroll(container.firstChild as Element)
      expect(screen.queryByText('Tip text')).toBeNull()
    })

    // A click-pinned toggletip is fixed-positioned like any other bubble and
    // detaches the same way, so scroll dismisses it too — deliberately widening
    // the Escape/blur/second-click contract documented on the component.
    it('dismisses a click-pinned toggletip', () => {
      render(<HoverTooltip text="Tip text" toggletip ariaLabel="More info">i</HoverTooltip>)
      fireEvent.click(screen.getByRole('button', { name: 'More info' }))
      expect(screen.getByText('Tip text')).toBeInTheDocument()
      fireEvent.scroll(window)
      expect(screen.queryByText('Tip text')).toBeNull()
    })

    // Re-hover has to work after a scroll dismissal: hide() resets the pinned
    // parity, and a stale `true` there would make the next click read as
    // "already open" and close instead of reopening.
    it('reopens on a later click after a scroll dismissal', () => {
      render(<HoverTooltip text="Tip text" toggletip ariaLabel="More info">i</HoverTooltip>)
      const trigger = screen.getByRole('button', { name: 'More info' })
      fireEvent.click(trigger)
      fireEvent.scroll(window)
      expect(screen.queryByText('Tip text')).toBeNull()
      fireEvent.click(trigger)
      expect(screen.getByText('Tip text')).toBeInTheDocument()
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

  // Filter buttons near the right edge of the window (BillList's filter row)
  // render a single-line, nowrap bubble with no maxWidth — the existing
  // clamp math is expressed entirely in terms of maxWidth, so it never
  // learns how wide the bubble actually rendered and can't bound it. The fix
  // measures the real bubble via a ref and clamps against that measurement.
  describe('viewport-aware clamping for placement="top"', () => {
    it('keeps a no-maxWidth bubble within the right edge of the viewport', () => {
      const restore = stubGeometry({
        innerWidth: 800,
        anchorRect: { left: 760, right: 800 },
        bubbleText: 'A long filter tooltip that runs wide',
        bubbleWidth: 300,
      })
      try {
        render(<HoverTooltip text="A long filter tooltip that runs wide"><button>trigger</button></HoverTooltip>)
        fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
        const bubble = screen.getByText('A long filter tooltip that runs wide')
        const left = parseFloat(bubble.style.left)
        // Bubble is centered via translateX(-50%): its right edge is left + width/2.
        expect(left + 300 / 2).toBeLessThanOrEqual(800 - 8 + 0.01)
        // Sanity: the unclamped center (anchor midpoint) would have been 780 —
        // confirm the fix actually moved it, not just happened to already fit.
        expect(left).toBeLessThan(780)
      } finally {
        restore()
      }
    })

    it('still clamps correctly when maxWidth is supplied (no regression)', () => {
      const restore = stubGeometry({
        innerWidth: 800,
        anchorRect: { left: 760, right: 800 },
        bubbleText: 'Wraps within maxWidth',
        bubbleWidth: 300,
      })
      try {
        render(<HoverTooltip text="Wraps within maxWidth" maxWidth={300}><button>trigger</button></HoverTooltip>)
        fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
        const bubble = screen.getByText('Wraps within maxWidth')
        const left = parseFloat(bubble.style.left)
        expect(left + 300 / 2).toBeLessThanOrEqual(800 - 8 + 0.01)
        expect(bubble.style.whiteSpace).toBe('normal')
        expect(bubble.style.maxWidth).toBe('300px')
      } finally {
        restore()
      }
    })

    it('clamps to a boundaryRef element instead of the viewport when one is given', () => {
      const boundaryRef = createRef<HTMLDivElement>()
      const restore = stubGeometry({
        innerWidth: 1200,
        anchorRect: { left: 660, right: 700 },
        bubbleText: 'Boundary-clamped tip',
        bubbleWidth: 300,
        boundaryRect: { left: 0, right: 700 },
      })
      try {
        render(
          <div data-testid="boundary" ref={boundaryRef}>
            <HoverTooltip text="Boundary-clamped tip" maxWidth={300} boundaryRef={boundaryRef}>
              <button>trigger</button>
            </HoverTooltip>
          </div>,
        )
        fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
        const bubble = screen.getByText('Boundary-clamped tip')
        const left = parseFloat(bubble.style.left)
        // Clamped against the 700px-wide boundary, not the 1200px viewport:
        // the viewport alone would not have required clamping at all (anchor
        // midpoint 680 + half-width 150 = 830 <= 1200), so a value at or
        // below the boundary's limit demonstrates the boundary path ran.
        expect(left + 300 / 2).toBeLessThanOrEqual(700 - 8 + 0.01)
      } finally {
        restore()
      }
    })
  })

  // The 'top' fix above only wired the real measurement into the 'top'
  // branch. 'bottom' and 'right' still gated their clamp on the `maxWidth`
  // prop alone — the exact bug the 'top' fix addressed, just untouched in
  // these branches — and 'top-start'/'top-end' had no clamp at all.
  describe('viewport-aware clamping for other placements', () => {
    it('keeps a no-maxWidth "bottom" bubble within the right edge of the viewport', () => {
      const restore = stubGeometry({
        innerWidth: 800,
        anchorRect: { left: 760, right: 800 },
        bubbleText: 'A long filter tooltip that runs wide',
        bubbleWidth: 300,
      })
      try {
        render(
          <HoverTooltip text="A long filter tooltip that runs wide" placement="bottom">
            <button>trigger</button>
          </HoverTooltip>,
        )
        fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
        const bubble = screen.getByText('A long filter tooltip that runs wide')
        const left = parseFloat(bubble.style.left)
        expect(left + 300 / 2).toBeLessThanOrEqual(800 - 8 + 0.01)
        expect(left).toBeLessThan(780)
      } finally {
        restore()
      }
    })

    it('keeps a no-maxWidth "right" bubble within the right edge of the viewport', () => {
      const restore = stubGeometry({
        innerWidth: 800,
        anchorRect: { left: 760, right: 800 },
        bubbleText: 'A long filter tooltip that runs wide',
        bubbleWidth: 300,
      })
      try {
        render(
          <HoverTooltip text="A long filter tooltip that runs wide" placement="right">
            <button>trigger</button>
          </HoverTooltip>,
        )
        fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
        const bubble = screen.getByText('A long filter tooltip that runs wide')
        // No room to the right of an anchor already at the viewport edge, so
        // this must have fallen back to the clamped centered-below position
        // rather than tooltipPositionRight (which would put it further right).
        expect(bubble.style.transform).toContain('translateX(-50%)')
        const left = parseFloat(bubble.style.left)
        expect(left + 300 / 2).toBeLessThanOrEqual(800 - 8 + 0.01)
      } finally {
        restore()
      }
    })

    it('keeps a "top-end" bubble within the right edge of the viewport', () => {
      const restore = stubGeometry({
        innerWidth: 800,
        anchorRect: { left: 780, right: 800 },
        bubbleText: 'A long filter tooltip that runs wide',
        bubbleWidth: 300,
      })
      try {
        render(
          <HoverTooltip text="A long filter tooltip that runs wide" placement="top-end">
            <button>trigger</button>
          </HoverTooltip>,
        )
        fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
        const bubble = screen.getByText('A long filter tooltip that runs wide')
        // top-end's `left` value paired with translateX(-100%) is the bubble's
        // right edge — assert that edge, not the raw `left` value, stays on screen.
        const rightEdge = parseFloat(bubble.style.left)
        expect(rightEdge).toBeLessThanOrEqual(800 - 8 + 0.01)
        expect(rightEdge - 300).toBeGreaterThanOrEqual(8 - 0.01)
      } finally {
        restore()
      }
    })

    it('keeps a "top-start" bubble within the right edge of the viewport', () => {
      const restore = stubGeometry({
        innerWidth: 800,
        anchorRect: { left: 760, right: 800 },
        bubbleText: 'A long filter tooltip that runs wide',
        bubbleWidth: 300,
      })
      try {
        render(
          <HoverTooltip text="A long filter tooltip that runs wide" placement="top-start">
            <button>trigger</button>
          </HoverTooltip>,
        )
        fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
        const bubble = screen.getByText('A long filter tooltip that runs wide')
        const left = parseFloat(bubble.style.left)
        // Unclamped, top-start would sit at the anchor's left edge (760) and
        // extend to 1060 — past the 800px viewport. Confirm it moved.
        expect(left + 300).toBeLessThanOrEqual(800 - 8 + 0.01)
        expect(left).toBeLessThan(760)
      } finally {
        restore()
      }
    })
  })
})

// Folded in from TermHover (now HoverTooltip's `describe` option).
const bubble = (text: string) => screen.getAllByText(text).find(el => el.style.position === 'fixed')
const EXPLAINER = 'A bill that became law.'
const term = () => screen.getByRole('button', { name: 'Chapter' })

describe('HoverTooltip describe option', () => {
  it('shows the explainer on hover, and a plain hover still closes on leave', () => {
    render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
    expect(bubble(EXPLAINER)).toBeUndefined()
    fireEvent.pointerEnter(term(), { pointerType: 'mouse' })
    expect(bubble(EXPLAINER)).toBeDefined()
    fireEvent.pointerLeave(term(), { pointerType: 'mouse' })
    expect(bubble(EXPLAINER)).toBeUndefined()
  })

  it('does not preview on a touch pointerenter, so a tap cannot strand the bubble', () => {
    render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
    fireEvent.pointerEnter(term(), { pointerType: 'touch' })
    expect(bubble(EXPLAINER)).toBeUndefined()
  })

  it('is a single keyboard tab stop: a button, with no second focusable inside it', () => {
    render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(term()).toHaveAttribute('type', 'button')
    expect(term().querySelector('[tabindex]')).toBeNull()
  })

  it('previews on keyboard focus and hides on blur', async () => {
    const user = userEvent.setup()
    render(<><HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip><button>next</button></>)
    await user.tab()
    expect(term()).toHaveFocus()
    expect(bubble(EXPLAINER)).toBeDefined()
    await user.tab()
    expect(bubble(EXPLAINER)).toBeUndefined()
  })

  describe('click, tap, Enter and Space toggle it, like the ⓘ', () => {
    it('opens on a click and closes on a second click', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.click(term())
      expect(bubble(EXPLAINER)).toBeDefined()
      await user.click(term())
      expect(bubble(EXPLAINER)).toBeUndefined()
    })

    it('opens on a tap and closes on a second tap', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.pointer({ keys: '[TouchA]', target: term() })
      expect(bubble(EXPLAINER)).toBeDefined()
      await user.pointer({ keys: '[TouchA]', target: term() })
      expect(bubble(EXPLAINER)).toBeUndefined()
    })

    it('a click pins it open after the mouse leaves', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.click(term())
      fireEvent.pointerLeave(term(), { pointerType: 'mouse' })
      expect(bubble(EXPLAINER)).toBeDefined()
    })

    it('Enter on the focused term toggles it: the first pins the preview, the second closes', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.tab()
      expect(bubble(EXPLAINER)).toBeDefined() // focus preview
      await user.keyboard('{Enter}')
      expect(bubble(EXPLAINER)).toBeDefined() // pinned
      await user.keyboard('{Enter}')
      expect(bubble(EXPLAINER)).toBeUndefined()
      await user.keyboard('{Enter}')
      expect(bubble(EXPLAINER)).toBeDefined() // and back open again
    })

    it('Space on the focused term toggles it the same way', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.tab()
      await user.keyboard(' ')
      expect(bubble(EXPLAINER)).toBeDefined()
      await user.keyboard(' ')
      expect(bubble(EXPLAINER)).toBeUndefined()
    })

    it('does not submit a form it sits in', async () => {
      const user = userEvent.setup()
      const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault())
      render(<form onSubmit={onSubmit}><HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip></form>)
      await user.click(term())
      await user.tab()
      await user.keyboard('{Enter}')
      expect(onSubmit).not.toHaveBeenCalled()
    })
  })

  describe('Escape', () => {
    it('closes a hover or focus preview, keeping focus on the term', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.tab()
      expect(term()).toHaveFocus()
      expect(bubble(EXPLAINER)).toBeDefined()
      await user.keyboard('{Escape}')
      expect(bubble(EXPLAINER)).toBeUndefined()
      expect(term()).toHaveFocus()
    })

    it('closes a click-pinned explainer, and the next click opens it again', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.click(term())
      expect(bubble(EXPLAINER)).toBeDefined()
      await user.keyboard('{Escape}')
      expect(bubble(EXPLAINER)).toBeUndefined()
      await user.click(term())
      expect(bubble(EXPLAINER)).toBeDefined()
    })

    it('closes it when the term is an interactive child', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe={{ id: 'status-explainer', interactive: true }}><button aria-describedby="status-explainer">Chapter</button></HoverTooltip>)
      await user.tab()
      expect(bubble(EXPLAINER)).toBeDefined()
      await user.keyboard('{Escape}')
      expect(bubble(EXPLAINER)).toBeUndefined()
    })
  })

  describe('look', () => {
    it('marks the term with a dotted underline', () => {
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      expect(screen.getByText('Chapter').style.borderBottom).toContain('dotted')
    })

    it('shows the pointer cursor, never the help cursor', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      expect(term().style.cursor).toBe('pointer')
      await user.click(term())
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) expect(el.style.cursor).not.toBe('help')
    })

    it('keeps the surrounding text styling: no button chrome, inherited font, color, case and spacing', () => {
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      const s = term().style
      expect(s.background).toBe('none')
      expect(s.padding).toBe('0px')
      expect(s.font).toBe('inherit')
      expect(s.color).toBe('inherit')
      expect(s.textTransform).toBe('inherit')
      expect(s.letterSpacing).toBe('inherit')
    })

    it('opens above with a wrapping bubble by default', () => {
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      fireEvent.pointerEnter(term(), { pointerType: 'mouse' })
      const b = bubble(EXPLAINER)!
      expect(b.style.maxWidth).toBe('320px')
      expect(b.style.transform).toBe('translateX(-50%) translateY(calc(-100% - 6px))')
    })
  })

  describe('screen readers', () => {
    it('describes the term by a hidden copy of the explainer while closed', () => {
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      expect(term()).toHaveAccessibleDescription(EXPLAINER)
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('announces the open state the way the ⓘ does: a role=tooltip bubble the button is described by', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      await user.click(term())
      const tip = screen.getByRole('tooltip')
      expect(tip).toHaveTextContent(EXPLAINER)
      expect(term().getAttribute('aria-describedby')).toBe(tip.id)
      expect(term()).toHaveAccessibleDescription(EXPLAINER)
      await user.click(term())
      expect(screen.queryByRole('tooltip')).toBeNull()
      expect(term()).toHaveAccessibleDescription(EXPLAINER)
    })

    it('uses the given id for the hidden copy', () => {
      render(<HoverTooltip text={EXPLAINER} describe={{ id: 'type-explainer' }}>Chapter</HoverTooltip>)
      expect(document.getElementById('type-explainer')).toHaveTextContent(EXPLAINER)
      expect(term().getAttribute('aria-describedby')).toBe('type-explainer')
    })

    it('exposes no aria-label of its own: the visible text is the name', () => {
      render(<HoverTooltip text={EXPLAINER} describe>Chapter</HoverTooltip>)
      expect(term()).not.toHaveAttribute('aria-label')
    })
  })

  describe('two explainers on one page', () => {
    function Two() {
      return (
        <p>
          <HoverTooltip text="First explainer." describe>First</HoverTooltip> and <HoverTooltip text="Second explainer." describe>Second</HoverTooltip>
        </p>
      )
    }

    it('opening the second by click closes the first, as two ⓘ do', async () => {
      const user = userEvent.setup()
      render(<Two />)
      await user.click(screen.getByRole('button', { name: 'First' }))
      expect(bubble('First explainer.')).toBeDefined()
      await user.click(screen.getByRole('button', { name: 'Second' }))
      expect(bubble('Second explainer.')).toBeDefined()
      expect(bubble('First explainer.')).toBeUndefined()
      expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    })

    it('each toggles independently: closing one leaves the other closed, and the other still opens', async () => {
      const user = userEvent.setup()
      render(<Two />)
      await user.click(screen.getByRole('button', { name: 'First' }))
      await user.click(screen.getByRole('button', { name: 'First' }))
      expect(screen.queryByRole('tooltip')).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Second' }))
      expect(screen.getAllByRole('tooltip')).toHaveLength(1)
    })

    it('hovering the second previews only the second once the first is closed', () => {
      render(<Two />)
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'First' }), { pointerType: 'mouse' })
      fireEvent.pointerLeave(screen.getByRole('button', { name: 'First' }), { pointerType: 'mouse' })
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Second' }), { pointerType: 'mouse' })
      expect(bubble('Second explainer.')).toBeDefined()
      expect(bubble('First explainer.')).toBeUndefined()
    })
  })

  describe('interactive children (the status chip) are unchanged', () => {
    const chip = () => screen.getByRole('button', { name: 'Chapter' })

    it('adds no wrapper button and no tab stop: the child stays the only control', () => {
      render(<HoverTooltip text={EXPLAINER} describe={{ id: 'status-explainer', interactive: true }}><button aria-describedby="status-explainer">Chapter</button></HoverTooltip>)
      expect(screen.getAllByRole('button')).toHaveLength(1)
      expect(chip()).not.toHaveAttribute('tabindex')
      expect(chip().parentElement?.tagName.toLowerCase()).toBe('span')
      expect(chip()).toHaveAccessibleDescription(EXPLAINER)
      expect(document.getElementById('status-explainer')).toHaveTextContent(EXPLAINER)
    })

    it('has no dotted underline and no pointer cursor of its own', () => {
      render(<HoverTooltip text={EXPLAINER} describe={{ id: 'status-explainer', interactive: true }}><button aria-describedby="status-explainer">Chapter</button></HoverTooltip>)
      expect(chip().style.borderBottom).toBe('')
      expect(chip().parentElement?.style.borderBottom).toBe('')
      expect(chip().parentElement?.style.cursor).toBe('')
    })

    it('clicking the chip runs its own click and does not pin or toggle the explainer', async () => {
      const user = userEvent.setup()
      const onClick = vi.fn()
      render(<HoverTooltip text={EXPLAINER} describe={{ id: 'status-explainer', interactive: true }}><button aria-describedby="status-explainer" onClick={onClick}>Chapter</button></HoverTooltip>)
      await user.click(chip())
      expect(onClick).toHaveBeenCalledTimes(1)
      fireEvent.pointerLeave(chip(), { pointerType: 'mouse' }) // not pinned: leaving closes the hover preview
      expect(bubble(EXPLAINER)).toBeUndefined()
    })

    it('still previews on hover and focus', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip text={EXPLAINER} describe={{ id: 'status-explainer', interactive: true }}><button aria-describedby="status-explainer">Chapter</button></HoverTooltip>)
      fireEvent.pointerEnter(chip(), { pointerType: 'mouse' })
      expect(bubble(EXPLAINER)).toBeDefined()
      fireEvent.pointerLeave(chip(), { pointerType: 'mouse' })
      expect(bubble(EXPLAINER)).toBeUndefined()
      await user.tab()
      expect(bubble(EXPLAINER)).toBeDefined()
    })
  })

  describe('the ⓘ (toggletip) is unchanged', () => {
    it('describes nothing while closed, and gets the bubble id while open', async () => {
      const user = userEvent.setup()
      render(<HoverTooltip toggletip ariaLabel="More information" text="Scored 1–10 by AI">i</HoverTooltip>)
      const btn = screen.getByRole('button', { name: 'More information' })
      expect(btn).not.toHaveAttribute('aria-describedby')
      expect(btn.style.textTransform).toBe('')
      await user.click(btn)
      expect(btn.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
    })

    it('ignores describe when toggletip is set, rendering no hidden copy', () => {
      render(<HoverTooltip toggletip describe ariaLabel="More information" text="Scored 1–10 by AI">i</HoverTooltip>)
      expect(screen.queryByText('Scored 1–10 by AI')).toBeNull()
    })
  })

  it('renders plain text when there is no explainer', () => {
    render(<HoverTooltip text={null} describe>Chapter</HoverTooltip>)
    expect(screen.queryByRole('button')).toBeNull()
    const el = screen.getByText('Chapter')
    expect(el).not.toHaveAttribute('tabindex')
    expect(el).not.toHaveAttribute('aria-describedby')
    expect(el.style.borderBottom).toBe('')
  })

  it('adds no tab stop or hidden copy when off', () => {
    render(<HoverTooltip text="Tip"><span>Chapter</span></HoverTooltip>)
    expect(screen.getByText('Chapter')).not.toHaveAttribute('tabindex')
    expect(screen.queryByText('Tip')).toBeNull()
  })
})

// Hover bubbles open above their trigger and flip below only where there is no
// room above (a trigger at the top of the viewport). jsdom lays nothing out, so
// the anchor's and the bubble's rectangles are stubbed; the flip arithmetic runs for real.
describe('opens above, and flips below only without room above', () => {
  function stubRects(anchor: { top: number; left?: number; width?: number }, bubbleText: string, bubbleHeight: number, bubbleWidth = 100) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    const originalH = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: HTMLElement) {
        if ((this.textContent === bubbleText && this.getAttribute('aria-hidden') !== null) || this.getAttribute('role') === 'tooltip') {
          return rect({ left: 0, right: bubbleWidth, top: 0, bottom: bubbleHeight })
        }
        const left = anchor.left ?? 300
        return rect({ left, right: left + (anchor.width ?? 40), top: anchor.top, bottom: anchor.top + 20 })
      },
    })
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', original)
      if (originalH) Object.defineProperty(window, 'innerHeight', originalH)
    }
  }
  const aboveTransform = (el: HTMLElement) => el.style.transform.includes('translateY(calc(-100% - 6px))')

  it('defaults to above when there is room', () => {
    const restore = stubRects({ top: 300 }, 'Tip', 30)
    try {
      render(<HoverTooltip text="Tip"><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      const b = screen.getByText('Tip')
      expect(aboveTransform(b)).toBe(true)
      expect(b.style.top).toBe('300px')
    } finally { restore() }
  })

  it('flips below the trigger when the bubble would not fit above it', () => {
    const restore = stubRects({ top: 10 }, 'Tip', 30)
    try {
      render(<HoverTooltip text="Tip"><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      const b = screen.getByText('Tip')
      expect(aboveTransform(b)).toBe(false)
      expect(b.style.top).toBe('36px')
    } finally { restore() }
  })

  it('stays above when it just fits', () => {
    const restore = stubRects({ top: 44 }, 'Tip', 30)
    try {
      render(<HoverTooltip text="Tip"><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      expect(aboveTransform(screen.getByText('Tip'))).toBe(true)
    } finally { restore() }
  })

  it.each(['top-start', 'top-end'] as const)('flips %s below too, keeping its horizontal alignment', placement => {
    const restore = stubRects({ top: 10, left: 400, width: 40 }, 'Tip', 30, 100)
    try {
      render(<HoverTooltip text="Tip" placement={placement}><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      const b = screen.getByText('Tip')
      expect(aboveTransform(b)).toBe(false)
      expect(b.style.top).toBe('36px')
      expect(b.style.transform).toContain(placement === 'top-start' ? 'translateX(0%)' : 'translateX(-100%)')
    } finally { restore() }
  })

  it('opens a term (describe) above, flipping below at the top of the page', () => {
    const restore = stubRects({ top: 10 }, 'Meaning', 30)
    try {
      render(<HoverTooltip text="Meaning" describe>Chapter</HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('Chapter'), { pointerType: 'mouse' })
      const b = document.querySelector<HTMLElement>('[role="tooltip"]')!
      expect(aboveTransform(b)).toBe(false)
      expect(b.style.top).toBe('36px')
    } finally { restore() }
  })

  it('opens a term (describe) above when there is room', () => {
    const restore = stubRects({ top: 300 }, 'Meaning', 30)
    try {
      render(<HoverTooltip text="Meaning" describe>Chapter</HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('Chapter'), { pointerType: 'mouse' })
      expect(aboveTransform(document.querySelector<HTMLElement>('[role="tooltip"]')!)).toBe(true)
    } finally { restore() }
  })

  it('opens a toggletip above by default', () => {
    const restore = stubRects({ top: 300 }, 'Info', 30)
    try {
      render(<HoverTooltip toggletip ariaLabel="More" text="Info">i</HoverTooltip>)
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'More' }), { pointerType: 'mouse' })
      expect(aboveTransform(screen.getByRole('tooltip'))).toBe(true)
    } finally { restore() }
  })

  it('falls back above, not below, when "right" has no room to the right', () => {
    const restore = stubRects({ top: 300, left: 700, width: 80 }, 'Wide tip text', 30, 300)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 })
    try {
      render(<HoverTooltip text="Wide tip text" placement="right" maxWidth={300}><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      expect(aboveTransform(screen.getByText('Wide tip text'))).toBe(true)
    } finally { restore() }
  })

  it('still lets a caller ask for below explicitly', () => {
    const restore = stubRects({ top: 300 }, 'Tip', 30)
    try {
      render(<HoverTooltip text="Tip" placement="bottom"><button>trigger</button></HoverTooltip>)
      fireEvent.pointerEnter(screen.getByText('trigger'), { pointerType: 'mouse' })
      expect(aboveTransform(screen.getByText('Tip'))).toBe(false)
    } finally { restore() }
  })
})
