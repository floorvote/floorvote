/**
 * Regression: opening the Calendar via the sidebar's deferred-nav link seeds
 * events from router state, so `loaded` is true on the FIRST render — before the
 * parent has measured the sticky header. The today-scroll runs as a child layout
 * effect (before the parent's measure effect), so if it fires while headerHeight
 * is still 0 it uses scrollMarginTop = 0 + TOP_GAP and lands today UNDER the
 * sticky header ("today sits too high / scrolled past").
 *
 * On mobile a second effect compounds it: the header reflows on web-font load
 * (FOUT) — the action buttons wrap to two rows under the fallback font (taller
 * header), then collapse to one when the font swaps in (shorter). The first
 * scroll uses the transient taller height, so today lands too LOW once the
 * header shrinks. So the scroll must (a) wait until headerHeight is measured,
 * and (b) re-pin whenever the header height changes — until the user scrolls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AgendaView } from './AgendaView'

const noop = () => {}
const baseProps = {
  events: [],
  isAdmin: false,
  onEdit: noop,
  onDelete: noop,
  onRestore: noop,
  billOptions: [],
  editingId: null,
  onEditSave: noop,
  onEditCancel: noop,
  focusEventId: null,
  onFocusHandled: noop,
}

function tree(headerHeight: number, loaded = true) {
  // Wrap in <main> so AgendaView's user-interaction listener (which attaches to
  // the closest scroll container) has something to bind to.
  return (
    <MemoryRouter>
      <main>
        <AgendaView {...baseProps} loaded={loaded} headerHeight={headerHeight} />
      </main>
    </MemoryRouter>
  )
}

describe('AgendaView scroll-to-today', () => {
  // The today-scroll scrolls the `main` container directly (via scrollTo) rather
  // than scrollIntoView, so the window — and the fixed mobile top bar — never move.
  let scrollSpy: ReturnType<typeof vi.fn>
  let original: typeof Element.prototype.scrollTo
  beforeEach(() => {
    scrollSpy = vi.fn()
    original = Element.prototype.scrollTo
    Element.prototype.scrollTo = scrollSpy as unknown as typeof Element.prototype.scrollTo
  })
  afterEach(() => {
    Element.prototype.scrollTo = original
  })

  it('does NOT scroll while the header height is still 0 (unmeasured)', () => {
    render(tree(0))
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('scrolls today into view once the header height is measured', () => {
    const { rerender } = render(tree(0))
    expect(scrollSpy).not.toHaveBeenCalled()
    rerender(tree(107))
    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('re-pins today when the header height changes (e.g. web-font reflow)', () => {
    const { rerender } = render(tree(148))
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    rerender(tree(107)) // header shrank after the font loaded
    expect(scrollSpy).toHaveBeenCalledTimes(2)
  })

  it('does not re-pin on a re-render that leaves the header height unchanged', () => {
    const { rerender } = render(tree(107))
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    rerender(tree(107))
    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('stops re-pinning once the user scrolls', () => {
    const { rerender, container } = render(tree(148))
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    const main = container.querySelector('main')!
    fireEvent.wheel(main) // user takes over
    rerender(tree(107))
    expect(scrollSpy).toHaveBeenCalledTimes(1) // no further re-pin
  })
})
