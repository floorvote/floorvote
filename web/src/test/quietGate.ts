import { it, expect } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { REQUIRED_MESSAGE } from '../components/RequiredField'

// Shared page-test checks for a submit button gated by useRequiredSubmit()
// while a required value is missing: quiet on load, looks disabled, reveals
// REQUIRED_MESSAGE on hover, keyboard focus, and click/tap, hides it on leave
// and blur, and never submits however it is pressed.

export interface QuietGateSetup {
  user: UserEvent
  /** The gated button, re-queried on each call. */
  button: () => HTMLElement
  /** How many times the form has submitted (requests sent, onSave calls, ...). */
  submitted: () => number
  /** Where the message renders; defaults to the whole document. */
  scope?: () => HTMLElement
}

export function gateMessage(scope?: HTMLElement): HTMLElement | null {
  return scope ? within(scope).queryByText(REQUIRED_MESSAGE) : screen.queryByText(REQUIRED_MESSAGE)
}

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'

/**
 * Moves keyboard focus onto `el` with a real Tab press: focuses the tabbable
 * element just before it and presses Tab, or, when that neighbor is a
 * rich-text editor (which keeps Tab for itself), focuses the one just after it
 * and presses Shift+Tab.
 */
export async function tabTo(user: UserEvent, el: HTMLElement) {
  const tabbables = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE))
    .filter(n => n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled)
  const i = tabbables.indexOf(el)
  expect(i).toBeGreaterThanOrEqual(0)
  const prev = tabbables[i - 1]
  // jsdom does not implement isContentEditable.
  if (prev && prev.getAttribute('contenteditable') !== 'true') {
    act(() => prev.focus())
    await user.tab()
  } else {
    const next = tabbables[i + 1]
    expect(next).toBeDefined()
    act(() => next.focus())
    await user.tab({ shift: true })
  }
  expect(document.activeElement).toBe(el)
}

/** Asserts the message is shown and tied to `button`, and is exactly REQUIRED_MESSAGE. */
export function expectMessageShown(button: HTMLElement, scope?: HTMLElement) {
  const msg = gateMessage(scope)
  expect(msg).toBeInTheDocument()
  expect(msg!.textContent).toBe(REQUIRED_MESSAGE)
  expect(button).toHaveAttribute('aria-describedby', msg!.id)
  expect(button).toHaveAccessibleDescription(REQUIRED_MESSAGE)
}

export function expectMessageHidden(button: HTMLElement, scope?: HTMLElement) {
  expect(gateMessage(scope)).not.toBeInTheDocument()
  expect(button).not.toHaveAttribute('aria-describedby')
}

/** Asserts `button` is gated quietly: aria-disabled, focusable, looks disabled. */
export function expectQuietlyBlocked(button: HTMLElement) {
  expect(button).toHaveAttribute('aria-disabled', 'true')
  // Not natively disabled: it must stay hoverable, focusable, and tappable.
  expect(button).not.toBeDisabled()
  expect(button.style.cursor).toBe('not-allowed')
}

/**
 * Registers the shared behavior tests for one gated button. `setup` renders
 * the form in a state where a required value is missing.
 */
export function itGatesQuietly(setup: () => Promise<QuietGateSetup>) {
  const scopeOf = (s: QuietGateSetup) => s.scope?.()

  it('shows no message on load', async () => {
    const s = await setup()
    expectMessageHidden(s.button(), scopeOf(s))
  })

  it('marks the blocked button aria-disabled and makes it look disabled, without native disabled', async () => {
    const s = await setup()
    expectQuietlyBlocked(s.button())
  })

  it('shows the message on hover and hides it on mouse leave', async () => {
    const s = await setup()
    await s.user.hover(s.button())
    expectMessageShown(s.button(), scopeOf(s))
    await s.user.unhover(s.button())
    expectMessageHidden(s.button(), scopeOf(s))
  })

  it('shows the message on keyboard focus and hides it on blur', async () => {
    const s = await setup()
    await tabTo(s.user, s.button())
    expectMessageShown(s.button(), scopeOf(s))
    await s.user.tab()
    expect(document.activeElement).not.toBe(s.button())
    expectMessageHidden(s.button(), scopeOf(s))
  })

  it('shows the message on click without submitting, and hides it on leave and blur', async () => {
    const s = await setup()
    await s.user.click(s.button())
    expectMessageShown(s.button(), scopeOf(s))
    expect(s.submitted()).toBe(0)
    await s.user.unhover(s.button())
    await s.user.tab()
    expectMessageHidden(s.button(), scopeOf(s))
    expect(s.submitted()).toBe(0)
  })

  it('shows the message on a touch tap without submitting', async () => {
    const s = await setup()
    await s.user.pointer({ keys: '[TouchA]', target: s.button() })
    expectMessageShown(s.button(), scopeOf(s))
    expect(s.submitted()).toBe(0)
  })

  it('does not submit when the focused button is pressed with Enter or Space', async () => {
    const s = await setup()
    await tabTo(s.user, s.button())
    await s.user.keyboard('{Enter}')
    await s.user.keyboard(' ')
    expect(s.submitted()).toBe(0)
    expectMessageShown(s.button(), scopeOf(s))
  })
}
