import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { CollapsibleSection, OPEN_PAINT_ROOM } from './CollapsibleSection'
import { CLAIM_GLOW } from '../lib/claimGlow'

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

function bodyOf(): HTMLElement {
  return screen.getByText('body content').closest('[aria-hidden]') as HTMLElement
}

describe('CollapsibleSection', () => {
  beforeEach(() => mockMatchMedia(false))

  it('renders children even when closed (always mounted)', () => {
    render(
      <CollapsibleSection label="Actions" open={false} onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('body content')).not.toBeNull()
  })

  it('collapses grid rows + hides body when closed, expands when open', () => {
    const { rerender } = render(
      <CollapsibleSection label="Actions" open={false} onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(bodyOf().style.gridTemplateRows).toBe('0fr')
    expect(bodyOf().getAttribute('aria-hidden')).toBe('true')
    expect(bodyOf().hasAttribute('inert')).toBe(true)

    rerender(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(bodyOf().style.gridTemplateRows).toBe('1fr')
    expect(bodyOf().getAttribute('aria-hidden')).toBe('false')
    expect(bodyOf().hasAttribute('inert')).toBe(false)
  })

  it('calls onToggle when the header is clicked', () => {
    const onToggle = vi.fn()
    render(
      <CollapsibleSection label="Actions" open={false} onToggle={onToggle}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Actions/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('reflects open state via aria-expanded on the header button', () => {
    const { rerender } = render(
      <CollapsibleSection label="Actions" open={false} onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.getByRole('button', { name: /Actions/ }).getAttribute('aria-expanded')).toBe('false')
    rerender(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.getByRole('button', { name: /Actions/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('renders the count badge only when count is provided', () => {
    const { rerender } = render(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('7')).toBeNull()
    rerender(
      <CollapsibleSection label="Actions" count={7} open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('7')).not.toBeNull()
  })

  it('shows closedSummary only when closed and openHint only when open', () => {
    const { rerender } = render(
      <CollapsibleSection
        label="Actions"
        open={false}
        onToggle={() => {}}
        closedSummary={<span>last action summary</span>}
        openHint={<span>most recent first</span>}
      >
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('last action summary')).not.toBeNull()
    expect(screen.queryByText('most recent first')).toBeNull()

    rerender(
      <CollapsibleSection
        label="Actions"
        open
        onToggle={() => {}}
        closedSummary={<span>last action summary</span>}
        openHint={<span>most recent first</span>}
      >
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('last action summary')).toBeNull()
    expect(screen.queryByText('most recent first')).not.toBeNull()
  })

  it('disables transitions under prefers-reduced-motion', () => {
    mockMatchMedia(true)
    render(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    // grid wrapper (rows transition)
    expect(bodyOf().style.transition).toBe('')
    // outer wrapper (box-shadow transition)
    expect((bodyOf().parentElement as HTMLElement).style.transition).toBe('')
    // inner content div (opacity/transform transition) — the <p>'s parent
    expect((screen.getByText('body content').parentElement as HTMLElement).style.transition).toBe('')
    // chevron (rotate transition)
    expect(screen.getByText('▼').style.transition).toBe('')
  })

  // The clip box (the grid row's only child) hides the body while the row
  // animates. Once a section is fully open the clip box makes room around the
  // body (padding, cancelled by a negative margin so nothing moves), so a
  // shadow inside the body (the claim quote box's glow, #696) shows whole
  // while anything wider than that is still clipped.
  describe('clipping', () => {
    function clipOf(): HTMLElement {
      return bodyOf().firstElementChild as HTMLElement
    }
    function roomOf(): number {
      const el = clipOf()
      expect(el.style.overflow).toBe('hidden')
      const pad = parseFloat(el.style.padding) || 0
      const margin = parseFloat(el.style.margin) || 0
      // The negative margin cancels the padding, so the body doesn't move.
      expect(margin + pad).toBe(0)
      return pad
    }
    function endRowsTransition(target: HTMLElement = bodyOf()) {
      // jsdom's TransitionEvent lacks propertyName, so build the event by hand.
      const ev = new Event('transitionend', { bubbles: true })
      Object.defineProperty(ev, 'propertyName', { value: 'grid-template-rows' })
      act(() => { target.dispatchEvent(ev) })
    }

    it('leaves room for the whole claim glow: its halo, its blur, and the floating shadow under it', () => {
      // shadow.md is `0 2px 8px`: 2px down plus an 8px blur.
      expect(OPEN_PAINT_ROOM).toBeGreaterThanOrEqual(Math.max(CLAIM_GLOW.haloSpread, CLAIM_GLOW.blur, 2 + 8))
    })

    it('makes no room while closed, so a closed section shows nothing', () => {
      render(
        <CollapsibleSection label="Bill texts" open={false} onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      expect(roomOf()).toBe(0)
    })

    it('makes room in a section that mounts open', () => {
      render(
        <CollapsibleSection label="Bill texts" open onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      expect(roomOf()).toBe(OPEN_PAINT_ROOM)
    })

    it('makes no room while the row animates open, then makes it once it has opened', () => {
      const { rerender } = render(
        <CollapsibleSection label="Bill texts" open={false} onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      rerender(
        <CollapsibleSection label="Bill texts" open onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      expect(roomOf()).toBe(0)
      endRowsTransition()
      expect(roomOf()).toBe(OPEN_PAINT_ROOM)
    })

    it('ignores a transition that ends inside the body', () => {
      const { rerender } = render(
        <CollapsibleSection label="Bill texts" open={false} onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      rerender(
        <CollapsibleSection label="Bill texts" open onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      endRowsTransition(screen.getByText('body content'))
      expect(roomOf()).toBe(0)
    })

    it('makes room after the animation time even if no transition event arrives', () => {
      vi.useFakeTimers()
      try {
        const { rerender } = render(
          <CollapsibleSection label="Bill texts" open={false} onToggle={() => {}}>
            <p>body content</p>
          </CollapsibleSection>,
        )
        rerender(
          <CollapsibleSection label="Bill texts" open onToggle={() => {}}>
            <p>body content</p>
          </CollapsibleSection>,
        )
        expect(roomOf()).toBe(0)
        act(() => { vi.advanceTimersByTime(1000) })
        expect(roomOf()).toBe(OPEN_PAINT_ROOM)
      } finally {
        vi.useRealTimers()
      }
    })

    it('drops the room as soon as it starts to close', () => {
      const { rerender } = render(
        <CollapsibleSection label="Bill texts" open onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      rerender(
        <CollapsibleSection label="Bill texts" open={false} onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      expect(roomOf()).toBe(0)
    })

    it('makes room at once under reduced motion, where nothing animates', () => {
      mockMatchMedia(true)
      const { rerender } = render(
        <CollapsibleSection label="Bill texts" open={false} onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      rerender(
        <CollapsibleSection label="Bill texts" open onToggle={() => {}}>
          <p>body content</p>
        </CollapsibleSection>,
      )
      expect(roomOf()).toBe(OPEN_PAINT_ROOM)
    })
  })
})

// #806: the open body's clip box reaches OPEN_PAINT_ROOM up over the header and
// is later in the DOM, so it painted above the title and swallowed its clicks.
// jsdom has no layout, so pin the stacking that keeps the header on top.
describe('CollapsibleSection header stays clickable when open (#806)', () => {
  beforeEach(() => mockMatchMedia(false))

  it('folds when the title is clicked after the open animation settles', async () => {
    const onToggle = vi.fn()
    render(
      <CollapsibleSection label="Actions" count={3} open onToggle={onToggle}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    await act(async () => { await new Promise(r => setTimeout(r, 300)) })
    fireEvent.click(screen.getByText('Actions'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('stacks the header above the body clip box that overlaps it', () => {
    render(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    const header = screen.getByRole('button', { name: /Actions/ }).parentElement as HTMLElement
    expect(header.style.position).toBe('relative')
    expect(header.style.zIndex).toBe('1')
  })
})
