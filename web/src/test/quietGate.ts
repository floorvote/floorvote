import type { CSSProperties } from 'react'
import { createElement } from 'react'
import { it, expect } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { REQUIRED_MESSAGE } from '../components/RequiredField'

// Shared page-test checks for a submit button gated by useRequiredSubmit()
// while a required value is missing: quiet on load, looks disabled, reveals
// REQUIRED_MESSAGE on hover, keyboard focus, and click/tap, hides it on leave
// and blur, and never submits however it is pressed.
//
// Layout (#237). Revealing the message must never move the button or anything
// above it: if it did, a hover could push the button out from under the
// cursor, the mouseleave would hide the message, the button would come back,
// and the page would jitter forever. So the message node is always mounted
// (visibility: hidden, aria-hidden, and no id while hidden, so nothing points
// at it) and sits on its own line BELOW the button's row. jsdom does no layout
// and cannot measure that a reveal moves nothing, so these structural checks
// are the guard: the node is present before any interaction, the node a
// reveal links to is that same node, it follows the button in document order,
// and it is not inside the button's row.

export interface QuietGateSetup {
  user: UserEvent
  /** The gated button, re-queried on each call. */
  button: () => HTMLElement
  /** How many times the form has submitted (requests sent, onSave calls, ...). */
  submitted: () => number
  /** Where the message renders; defaults to the whole document. */
  scope?: () => HTMLElement
}

/** Every REQUIRED_MESSAGE node in `scope`, shown or not. */
export function gateMessages(scope?: HTMLElement): HTMLElement[] {
  return scope ? within(scope).queryAllByText(REQUIRED_MESSAGE) : screen.queryAllByText(REQUIRED_MESSAGE)
}

// The node's own visibility, the one thing a reveal changes. Not jest-dom's
// toBeVisible(): that also checks every ancestor, so a host still fading in
// (PopPanel starts at opacity 0 until the next animation frame) would make the
// result depend on timing.
function ownVisibility(el: HTMLElement): string {
  return getComputedStyle(el).visibility
}

function isShown(el: HTMLElement): boolean {
  return ownVisibility(el) !== 'hidden' && !el.hasAttribute('aria-hidden')
}

/**
 * The message the user sees in `scope`, or null when none is shown. (Hidden
 * message nodes are always in the DOM, so "not in the document" no longer
 * means "not shown".)
 */
export function gateMessage(scope?: HTMLElement): HTMLElement | null {
  const shown = gateMessages(scope).filter(isShown)
  expect(shown.length).toBeLessThanOrEqual(1)
  return shown[0] ?? null
}

/** Asserts `el` is a message node in its hidden state: reserved, invisible, unreferenced. */
export function expectHiddenMessageNode(el: HTMLElement) {
  expect(el).toBeInTheDocument()
  expect(ownVisibility(el)).toBe('hidden')
  expect(el).toHaveAttribute('aria-hidden', 'true')
  // No id while hidden, so no aria-describedby can reach it.
  expect(el).not.toHaveAttribute('id')
}

/** The button's row: its nearest flex row ancestor, or its parent if none. */
export function buttonRow(button: HTMLElement): HTMLElement {
  for (let el = button.parentElement; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el)
    const flex = cs.display === 'flex' || cs.display === 'inline-flex'
    if (flex && !cs.flexDirection.startsWith('column')) return el
  }
  return button.parentElement!
}

/**
 * Asserts `msg` sits on its own line below `button`'s row: after the button
 * in document order, and inside neither the button's parent nor its nearest
 * flex row, so revealing it cannot reflow the row the button sits in.
 */
export function expectMessageBelowButton(button: HTMLElement, msg: HTMLElement) {
  expect(button.compareDocumentPosition(msg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(button.parentElement!.contains(msg)).toBe(false)
  expect(buttonRow(button).contains(msg)).toBe(false)
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

/**
 * Asserts the message is shown, visible, tied to `button`, and is exactly
 * REQUIRED_MESSAGE. Returns the message node.
 */
export function expectMessageShown(button: HTMLElement, scope?: HTMLElement): HTMLElement {
  const id = button.getAttribute('aria-describedby')
  expect(id).toBeTruthy()
  const msg = document.getElementById(id!)
  expect(msg).toBeInTheDocument()
  if (scope) expect(scope.contains(msg)).toBe(true)
  expect(msg!.textContent).toBe(REQUIRED_MESSAGE)
  expect(ownVisibility(msg!)).toBe('visible')
  expect(msg).not.toHaveAttribute('aria-hidden')
  expect(gateMessage(scope)).toBe(msg)
  expect(button).toHaveAccessibleDescription(REQUIRED_MESSAGE)
  return msg!
}

/**
 * Asserts no message is shown in `scope` and `button` points at none. Every
 * message node there must be in its hidden state.
 */
export function expectMessageHidden(button: HTMLElement, scope?: HTMLElement) {
  for (const el of gateMessages(scope)) expectHiddenMessageNode(el)
  expect(gateMessage(scope)).toBeNull()
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

  it('keeps the hidden message mounted before any interaction, unreferenced and aria-hidden', async () => {
    const s = await setup()
    const nodes = gateMessages(scopeOf(s))
    expect(nodes.length).toBeGreaterThanOrEqual(1)
    for (const el of nodes) expectHiddenMessageNode(el)
    expect(s.button()).not.toHaveAttribute('aria-describedby')
  })

  // The jitter guard (#237); see the layout note at the top of this file.
  for (const [how, reveal] of [
    ['hover', (s: QuietGateSetup) => s.user.hover(s.button())],
    ['keyboard focus', (s: QuietGateSetup) => tabTo(s.user, s.button())],
    ['click', (s: QuietGateSetup) => s.user.click(s.button())],
  ] as const) {
    it(`reveals on ${how} the same node that was reserved, on its own line below the button's row`, async () => {
      const s = await setup()
      const before = gateMessages(scopeOf(s))
      await reveal(s)
      const msg = expectMessageShown(s.button(), scopeOf(s))
      expect(before).toContain(msg)
      expectMessageBelowButton(s.button(), msg)
    })
  }

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

function declarations(el: HTMLElement): string[] {
  return el.style.cssText.split(';').map(d => d.trim()).filter(Boolean).sort()
}

/**
 * Asserts `button`'s inline style is exactly `style` (e.g. a shared
 * inlineEditSaveStyle(disabled)), however React ordered the declarations.
 */
export function expectButtonStyle(button: HTMLElement, style: CSSProperties) {
  const { container, unmount } = render(createElement('button', { style }))
  const expected = declarations(container.firstChild as HTMLElement)
  unmount()
  expect(declarations(button)).toEqual(expected)
}
