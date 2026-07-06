import { describe, it, expect, vi, afterEach } from 'vitest'
import { isModifiedClick, maybeOpenInNewTab } from './modifierClick'

// A modified click (⌘/Ctrl/Shift, or any non-primary mouse button) should bypass
// SPA navigation so the browser performs its native action (open in a new tab /
// window). isModifiedClick is the single guard every nav entry point shares.
describe('isModifiedClick', () => {
  it('returns false for a plain primary-button left-click', () => {
    expect(isModifiedClick({ metaKey: false, ctrlKey: false, shiftKey: false, button: 0 })).toBe(false)
  })

  it('returns true for ⌘ (meta) click — opens in a new tab on macOS', () => {
    expect(isModifiedClick({ metaKey: true, ctrlKey: false, shiftKey: false, button: 0 })).toBe(true)
  })

  it('returns true for Ctrl click — opens in a new tab on Windows/Linux', () => {
    expect(isModifiedClick({ metaKey: false, ctrlKey: true, shiftKey: false, button: 0 })).toBe(true)
  })

  it('returns true for Shift click — opens in a new window', () => {
    expect(isModifiedClick({ metaKey: false, ctrlKey: false, shiftKey: true, button: 0 })).toBe(true)
  })

  it('returns true for a middle-click (button 1)', () => {
    expect(isModifiedClick({ metaKey: false, ctrlKey: false, shiftKey: false, button: 1 })).toBe(true)
  })

  it('returns true for any non-primary button', () => {
    expect(isModifiedClick({ metaKey: false, ctrlKey: false, shiftKey: false, button: 2 })).toBe(true)
  })
})

// For pseudo-links (role="link" spans/divs that can't be a real <a> — e.g. a
// count chip nested inside the Bills NavLink anchor), a modified/middle click
// can't fall through to native link behavior because there's no href. This
// shim opens the target in a new tab for those clicks instead.
describe('maybeOpenInNewTab', () => {
  afterEach(() => vi.restoreAllMocks())

  function fakeEvent(over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }>) {
    return {
      metaKey: false, ctrlKey: false, shiftKey: false, button: 0,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
      ...over,
    }
  }

  it('does nothing and returns false for a plain left-click (SPA nav handles it)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const e = fakeEvent({})
    expect(maybeOpenInNewTab(e, '/bills')).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('opens the target in a new tab on ⌘-click and returns true', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const e = fakeEvent({ metaKey: true })
    expect(maybeOpenInNewTab(e, '/bills?newMatches=1')).toBe(true)
    expect(open).toHaveBeenCalledWith('/bills?newMatches=1', '_blank', 'noopener')
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })

  it('opens the target in a new tab on a middle-click (button 1)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const e = fakeEvent({ button: 1 })
    expect(maybeOpenInNewTab(e, '/calendar')).toBe(true)
    expect(open).toHaveBeenCalledWith('/calendar', '_blank', 'noopener')
  })
})
