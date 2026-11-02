import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Fold, FoldToggle, FOLD_LINK_STYLE, useFold } from './Fold'
import { EASE } from './CollapsibleSection'
import { color, fontSize } from '../styles/tokens'

// jsdom does no layout and has no Element.animate, so both are stubbed:
// - scrollHeight/clientHeight decide whether the folded content overflows.
// - getBoundingClientRect gives the clip box a height that depends on what it
//   currently renders (folded or open), unless a test pins a live in-flight height.
const dims = { scrollHeight: 0, clientHeight: 0, folded: 40, open: 120, live: null as number | null }

interface FakeAnimation { keyframes: unknown; options: unknown; cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; oncancel: (() => void) | null }
let animations: FakeAnimation[]
let spies: Array<{ mockRestore: () => void }>

beforeEach(() => {
  Object.assign(dims, { scrollHeight: 0, clientHeight: 0, folded: 40, open: 120, live: null })
  animations = []
  spies = [
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => dims.scrollHeight),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => dims.clientHeight),
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const state = this.getAttribute('data-fold-state')
      let height = state == null ? 0 : (state === 'open' ? dims.open : dims.folded)
      // A pinned in-flight height answers the first read only (the "from" read before a
      // click cancels the running animation); the box is back to its natural height after.
      if (state != null && dims.live != null) { height = dims.live; dims.live = null }
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
    }),
  ]
})
afterEach(() => {
  spies.forEach(s => s.mockRestore())
  // @ts-expect-error jsdom has no Element.animate; tests that install one remove it here
  delete Element.prototype.animate
  vi.unstubAllGlobals()
})

function installAnimate() {
  Element.prototype.animate = vi.fn(function (keyframes: unknown, options: unknown) {
    const a: FakeAnimation = { keyframes, options, cancel: vi.fn(), onfinish: null, oncancel: null }
    animations.push(a)
    return a
  }) as unknown as typeof Element.prototype.animate
}

function reduceMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'), media: query,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false, onchange: null,
  }))
}

const overflow = () => { dims.scrollHeight = 90; dims.clientHeight = 36 }
const content = () => screen.getByTestId('body')
const toggle = () => screen.getByRole('button')
const finish = (i: number) => act(() => { animations[i].onfinish?.() })
const cancelled = (i: number) => act(() => { animations[i].oncancel?.() })

function TextFold({ lines = 2 }: { lines?: number }) {
  return <Fold collapsed={{ lines }}><span data-testid="body">Some long text that runs on.</span></Fold>
}

describe('Fold toggle visibility and labels', () => {
  it('shows "Show more" with aria-expanded=false when the content overflows; click opens it and relabels it "Show less"', () => {
    overflow()
    render(<TextFold />)
    const btn = toggle()
    expect(btn).toHaveAccessibleName('Show more')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(toggle()).toHaveAccessibleName('Show less')
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).toHaveAccessibleName('Show more')
  })

  it('renders no toggle when the content does not overflow', () => {
    dims.scrollHeight = 36; dims.clientHeight = 36
    render(<TextFold />)
    expect(content()).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('tolerates sub-pixel overflow (scrollHeight one pixel over)', () => {
    dims.scrollHeight = 37; dims.clientHeight = 36
    render(<TextFold />)
    expect(content()).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps "Show less" while open even though the open content no longer overflows', () => {
    overflow()
    render(<TextFold />)
    fireEvent.click(toggle())
    act(() => { dims.scrollHeight = 90; dims.clientHeight = 90; window.dispatchEvent(new Event('resize')) })
    expect(toggle()).toHaveAccessibleName('Show less')
  })

  it('adds the toggle when a resize makes the content overflow, and drops it when it fits again', () => {
    dims.scrollHeight = 36; dims.clientHeight = 36
    render(<TextFold />)
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { dims.scrollHeight = 72; window.dispatchEvent(new Event('resize')) })
    expect(toggle()).toBeInTheDocument()
    act(() => { dims.scrollHeight = 36; window.dispatchEvent(new Event('resize')) })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('re-measures when the content box itself resizes (ResizeObserver)', () => {
    let notify: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { notify = cb }
      observe() {}
      disconnect() {}
      unobserve() {}
    })
    dims.scrollHeight = 36; dims.clientHeight = 36
    render(<TextFold />)
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { dims.scrollHeight = 90; notify() })
    expect(toggle()).toBeInTheDocument()
  })

  it('re-measures when its children change', () => {
    dims.scrollHeight = 36; dims.clientHeight = 36
    const { rerender } = render(<Fold collapsed={{ lines: 2 }}>short</Fold>)
    expect(screen.queryByRole('button')).toBeNull()
    dims.scrollHeight = 90
    rerender(<Fold collapsed={{ lines: 2 }}>a much longer body of text</Fold>)
    expect(toggle()).toBeInTheDocument()
  })

  it('does not mistake open (unclamped) content for overflow after it folds again', () => {
    overflow()
    render(<TextFold />)
    fireEvent.click(toggle())
    dims.scrollHeight = 36
    fireEvent.click(toggle())
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the toggle look: text fold vs count fold', () => {
  it('a text fold renders a chevron that turns over when open', () => {
    overflow()
    render(<TextFold />)
    const chev = () => toggle().querySelector('[data-fold-chevron]') as HTMLElement
    expect(chev()).not.toBeNull()
    expect(chev()).toHaveAttribute('aria-hidden', 'true')
    expect(chev().textContent).toBe('▼')
    expect(chev().style.transform).toBe('rotate(0deg)')
    fireEvent.click(toggle())
    expect(chev().style.transform).toBe('rotate(180deg)')
  })

  it('a count fold reads "+N more" with the right N and renders no chevron', () => {
    render(<FoldToggle open={false} count={7} onToggle={() => {}} />)
    expect(toggle()).toHaveAccessibleName('+7 more')
    expect(toggle().querySelector('[data-fold-chevron]')).toBeNull()
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('an open count fold reads "Show less" with no chevron', () => {
    render(<FoldToggle open count={7} onToggle={() => {}} />)
    expect(toggle()).toHaveAccessibleName('Show less')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(toggle().querySelector('[data-fold-chevron]')).toBeNull()
  })

  it('wears the 12px link style as a real button of type=button', () => {
    overflow()
    render(<TextFold />)
    expect(toggle().tagName).toBe('BUTTON')
    expect(toggle()).toHaveAttribute('type', 'button')
    expect(toggle().style.fontSize).toBe(`${fontSize.sm}px`)
    expect(toggle().style.color).toBe(color.linkBlue)
    expect(FOLD_LINK_STYLE.color).toBe(color.linkBlue)
    expect(FOLD_LINK_STYLE.fontSize).toBe(fontSize.sm)
  })

  it('hugs the text it folds: 1px above, so the gap after the fold groups it with the text', () => {
    render(<FoldToggle open={false} onToggle={() => {}} />)
    expect(toggle().style.marginTop).toBe('1px')
  })

  it('sits on its own line under the content, not inside the clamped box', () => {
    overflow()
    render(<TextFold />)
    expect(content().contains(toggle())).toBe(false)
    expect(content().compareDocumentPosition(toggle()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('points aria-controls at the clip box it opens', () => {
    overflow()
    render(<TextFold />)
    const id = toggle().getAttribute('aria-controls')
    expect(id).toBeTruthy()
    expect(document.getElementById(id!)).toContainElement(content())
  })
})

describe('what is folded', () => {
  it('a text fold clamps to the given number of lines, and unclamps when open', () => {
    overflow()
    render(<TextFold lines={3} />)
    const box = content().parentElement as HTMLElement
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('3')
    expect(box.style.overflow).toBe('hidden')
    fireEvent.click(toggle())
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('')
  })

  it('a rendered block folds by height, with a bottom fade only while it is cut off', () => {
    overflow()
    render(<Fold collapsed={{ maxHeight: '6em', fade: true }}><p data-testid="body">Rendered markdown</p></Fold>)
    const box = content().parentElement as HTMLElement
    expect(box.style.maxHeight).toBe('6em')
    expect(box.style.overflow).toBe('hidden')
    // jsdom's CSS parser drops mask-image, so the fade is observed through its marker.
    expect(box).toHaveAttribute('data-fold-fade')
    fireEvent.click(toggle())
    expect(box.style.maxHeight).toBe('')
    expect(box).not.toHaveAttribute('data-fold-fade')
  })

  it('a rendered block that fits gets neither a toggle nor a fade', () => {
    dims.scrollHeight = 50; dims.clientHeight = 50
    render(<Fold collapsed={{ maxHeight: 120, fade: true }}><p data-testid="body">Short</p></Fold>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(content().parentElement).not.toHaveAttribute('data-fold-fade')
  })

  it('renders a paragraph when asked to, so a prose fold keeps its element', () => {
    overflow()
    render(<Fold as="p" collapsed={{ lines: 2 }}>words</Fold>)
    expect(screen.getByText('words').tagName).toBe('P')
  })
})

describe('motion', () => {
  it('with reduced motion, toggling applies the end state without starting an animation', () => {
    installAnimate(); reduceMotion(true); overflow()
    render(<TextFold />)
    fireEvent.click(toggle())
    expect(Element.prototype.animate).not.toHaveBeenCalled()
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle())
    expect(Element.prototype.animate).not.toHaveBeenCalled()
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    // The folded end state is applied at once: the clamp is back.
    expect((content().parentElement as HTMLElement).style.overflow).toBe('hidden')
  })

  it('with motion, toggling starts a 240ms height animation on the shared easing curve', () => {
    installAnimate(); reduceMotion(false); overflow()
    render(<TextFold />)
    fireEvent.click(toggle())
    expect(Element.prototype.animate).toHaveBeenCalledTimes(1)
    expect(animations[0].keyframes).toEqual([{ height: '40px' }, { height: '120px' }])
    expect(animations[0].options).toEqual({ duration: 240, easing: EASE, fill: 'forwards' })
    expect(EASE).toBe('cubic-bezier(.4, 0, .2, 1)')
  })

  it('clips the box only while the animation runs', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    fireEvent.click(toggle())
    const clip = document.getElementById(toggle().getAttribute('aria-controls')!)!
    expect(clip.style.overflow).toBe('hidden')
    finish(0)
    expect(clip.style.overflow).toBe('')
  })

  it('does not animate when the open and folded heights are the same', () => {
    installAnimate(); overflow(); dims.open = 40
    render(<TextFold />)
    fireEvent.click(toggle())
    expect(Element.prototype.animate).not.toHaveBeenCalled()
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('works where Element.animate does not exist (applies the end state)', () => {
    overflow()
    render(<TextFold />)
    expect(typeof Element.prototype.animate).toBe('undefined')
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(toggle()).toHaveAccessibleName('Show less')
  })

  it('folding keeps the open content visible until the animation finishes', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    const box = content().parentElement as HTMLElement
    const clamp = () => box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')
    fireEvent.click(toggle())
    finish(0)
    expect(clamp()).toBe('')

    fireEvent.click(toggle())
    expect(Element.prototype.animate).toHaveBeenCalledTimes(2)
    expect(animations[1].keyframes).toEqual([{ height: '120px' }, { height: '40px' }])
    // The control already reports the fold, but the full content is still showing.
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).toHaveAccessibleName('Show more')
    expect(clamp()).toBe('')
    finish(1)
    expect(clamp()).toBe('2')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opening swaps to the open content at once and holds it through the animation', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    const box = content().parentElement as HTMLElement
    fireEvent.click(toggle())
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('')
    expect(animations).toHaveLength(1)
  })

  it('a rapid second click cancels the running animation and reverses from the current height', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    fireEvent.click(toggle())
    expect(animations).toHaveLength(1)
    dims.live = 77 // the box is mid-way through opening
    fireEvent.click(toggle())
    expect(animations[0].cancel).toHaveBeenCalledTimes(1)
    expect(animations).toHaveLength(2)
    expect(animations[1].keyframes).toEqual([{ height: '77px' }, { height: '40px' }])
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    dims.live = null
    finish(1)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).toHaveAccessibleName('Show more')
    expect((content().parentElement as HTMLElement).style.webkitLineClamp
      || (content().parentElement as HTMLElement).style.getPropertyValue('-webkit-line-clamp')).toBe('2')
  })

  it('three quick clicks end open, with every earlier animation cancelled', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    fireEvent.click(toggle())
    dims.live = 80
    fireEvent.click(toggle())
    dims.live = 60
    fireEvent.click(toggle())
    expect(animations[0].cancel).toHaveBeenCalledTimes(1)
    expect(animations[1].cancel).toHaveBeenCalledTimes(1)
    expect(animations[2].cancel).not.toHaveBeenCalled()
    finish(2)
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(toggle()).toHaveAccessibleName('Show less')
    const box = content().parentElement as HTMLElement
    expect(box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')).toBe('')
  })

  it('on finishing a fold, drops the held content in the same task and releases the forwards fill', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    const box = content().parentElement as HTMLElement
    const clamp = () => box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')
    fireEvent.click(toggle())
    finish(0)
    fireEvent.click(toggle())
    expect(clamp()).toBe('') // held open while it shrinks
    expect((animations[1].options as { fill?: string }).fill).toBe('forwards')
    // No act() and no await: the browser's finish event runs this and paints next. If the
    // folded form isn't committed by the time it returns, one frame shows the open content
    // at its natural height (the flash below the fold).
    animations[1].onfinish?.()
    expect(clamp()).toBe('2')
    expect((box.parentElement as HTMLElement).style.overflow).toBe('')
    expect(animations[1].cancel).toHaveBeenCalledTimes(1)
  })

  // Open, finish, then fold (animation 1), open again (same height as open: no motion, animation 1
  // is cancelled by us), fold again (animation 2). Animation 1's events can now arrive late.
  function supersededFold() {
    installAnimate(); overflow()
    render(<TextFold />)
    const box = content().parentElement as HTMLElement
    const clip = box.parentElement as HTMLElement
    const clamp = () => box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')
    fireEvent.click(toggle())
    finish(0)
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(animations).toHaveLength(3)
    expect(clamp()).toBe('')
    expect(clip.style.overflow).toBe('hidden')
    return { clip, clamp }
  }

  it('a late cancel event from a superseded animation leaves the running fold held, clipped and released only by its own finish', () => {
    const { clip, clamp } = supersededFold()
    animations[1].oncancel?.()
    expect(clamp()).toBe('')
    expect(clip.style.overflow).toBe('hidden')
    expect(animations[2].cancel).not.toHaveBeenCalled()
    animations[2].onfinish?.()
    expect(clamp()).toBe('2')
    expect(clip.style.overflow).toBe('')
    expect(animations[2].cancel).toHaveBeenCalledTimes(1)
  })

  it('a late finish event from a superseded animation does not settle or cancel the running fold', () => {
    const { clip, clamp } = supersededFold()
    animations[1].onfinish?.()
    expect(clamp()).toBe('')
    expect(clip.style.overflow).toBe('hidden')
    expect(animations[2].cancel).not.toHaveBeenCalled()
    // The real one still settles it afterwards.
    animations[2].onfinish?.()
    expect(clamp()).toBe('2')
    expect(animations[2].cancel).toHaveBeenCalledTimes(1)
  })

  it('commits the folded content before it releases the fill', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    const box = content().parentElement as HTMLElement
    const clamp = () => box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')
    fireEvent.click(toggle())
    finish(0)
    let seen: string | null = null
    fireEvent.click(toggle())
    animations[1].cancel.mockImplementation(() => { seen = clamp() })
    animations[1].onfinish?.()
    // Releasing the fill earlier would paint the open content at its natural height.
    expect(seen).toBe('2')
  })

  it('an animation cancelled from outside while folding drops the held open content', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    const box = content().parentElement as HTMLElement
    const clamp = () => box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')
    fireEvent.click(toggle())
    finish(0)
    fireEvent.click(toggle())
    expect(clamp()).toBe('') // held open while it shrinks
    // Something else cancels it (the page hid, an extension, devtools): onfinish never fires.
    cancelled(1)
    expect(clamp()).toBe('2')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('a cancel from a superseded animation does not drop the hold of the one that replaced it', () => {
    installAnimate(); overflow()
    render(<TextFold />)
    const box = content().parentElement as HTMLElement
    const clamp = () => box.style.webkitLineClamp || box.style.getPropertyValue('-webkit-line-clamp')
    fireEvent.click(toggle())
    finish(0)
    fireEvent.click(toggle()) // folding: animation 1
    fireEvent.click(toggle()) // opens again (already at open height: no motion), animation 1 is cancelled
    fireEvent.click(toggle()) // folding again: animation 2
    expect(animations).toHaveLength(3)
    // The browser reports animation 1's cancel late, after animation 2 took over.
    cancelled(1)
    expect(clamp()).toBe('')
    finish(2)
    expect(clamp()).toBe('2')
  })

  it('cancels a running animation when it unmounts', () => {
    installAnimate(); overflow()
    const { unmount } = render(<TextFold />)
    fireEvent.click(toggle())
    unmount()
    expect(animations[0].cancel).toHaveBeenCalled()
  })

  it('animates the chevron turn with the shared easing, and not when motion is reduced', () => {
    overflow(); reduceMotion(false)
    const { unmount } = render(<TextFold />)
    expect((toggle().querySelector('[data-fold-chevron]') as HTMLElement).style.transition).toContain(EASE)
    unmount()
    reduceMotion(true)
    render(<TextFold />)
    expect((toggle().querySelector('[data-fold-chevron]') as HTMLElement).style.transition).toBe('')
  })
})

describe('keyboard and clicks', () => {
  it('toggles with Enter and with Space', async () => {
    overflow()
    const user = userEvent.setup()
    render(<TextFold />)
    toggle().focus()
    await user.keyboard('{Enter}')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })

  it('a toggle click does not bubble to a parent onClick, and is default-prevented so a surrounding link is not followed', () => {
    overflow()
    const parentClick = vi.fn()
    render(
      <a href="#bill" onClick={parentClick}><TextFold /></a>,
    )
    const notPrevented = fireEvent.click(toggle())
    expect(notPrevented).toBe(false)
    expect(parentClick).not.toHaveBeenCalled()
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
  })

  it('a middle click on the toggle does not reach a parent that opens a link on auxclick', () => {
    const onAux = vi.fn()
    render(<div onAuxClick={onAux}><FoldToggle open={false} onToggle={() => {}} /></div>)
    fireEvent(toggle(), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(onAux).not.toHaveBeenCalled()
  })

  it('a count-fold toggle also stops the click and calls onToggle once', () => {
    const parentClick = vi.fn(); const onToggle = vi.fn()
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    render(<div onClick={parentClick}><FoldToggle open={false} count={3} onToggle={onToggle} /></div>)
    fireEvent.click(toggle())
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('clicking the content itself does not toggle', () => {
    overflow()
    render(<TextFold />)
    fireEvent.click(content())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('useFold for folds that are not clamped text (count folds)', () => {
  function CountFold({ total, cap }: { total: number; cap: number }) {
    const fold = useFold()
    const shown = fold.expanded ? total : cap
    return (
      <div>
        <div {...fold.clipProps} data-testid="clip">{Array.from({ length: shown }, (_, i) => <span key={i} data-testid="chip" />)}</div>
        <FoldToggle open={fold.open} count={total - cap} onToggle={fold.toggle} />
      </div>
    )
  }

  it('shows all items once open and the capped set when folded', () => {
    render(<CountFold total={9} cap={6} />)
    expect(screen.getAllByTestId('chip')).toHaveLength(6)
    expect(toggle()).toHaveAccessibleName('+3 more')
    fireEvent.click(toggle())
    expect(screen.getAllByTestId('chip')).toHaveLength(9)
    expect(toggle()).toHaveAccessibleName('Show less')
    fireEvent.click(toggle())
    expect(screen.getAllByTestId('chip')).toHaveLength(6)
  })

  it('holds every item through the fold animation, then drops to the cap', () => {
    installAnimate()
    render(<CountFold total={9} cap={6} />)
    fireEvent.click(toggle())
    finish(0)
    fireEvent.click(toggle())
    expect(animations).toHaveLength(2)
    expect(screen.getAllByTestId('chip')).toHaveLength(9)
    expect(toggle()).toHaveAccessibleName('+3 more')
    finish(1)
    expect(screen.getAllByTestId('chip')).toHaveLength(6)
  })
})
