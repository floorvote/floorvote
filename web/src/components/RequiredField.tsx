import { useCallback, useId, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { color, fontWeight } from '../styles/tokens'
import { FORM_LABEL, HELPER_TEXT } from '../lib/textStyles'

// The shared required-field pattern. A form with a required value:
//
//   1. sets aria-required on each required input. A field whose control is a
//      button (a Picker trigger) cannot carry aria-required, so it puts the
//      requirement in its accessible name with requiredName(). Only a form that
//      mixes required and optional inputs also marks the required ones visibly,
//      with <RequiredLabel> or <RequiredMarker />; on a form whose inputs are all
//      required, an empty box speaks for itself.
//   2. gates its submit button with useRequiredSubmit(), passing the
//      missing-required check separately from every other disabled reason, and
//      renders <MissingRequiredReason {...gate.reasonProps} /> on its own line
//      BELOW the button's row: after the row element, never inside it, and
//      never inline before or beside the button.
//
// The gate is quiet until tried. While a required value is missing the button
// looks disabled and carries aria-disabled, but stays hoverable, focusable, and
// tappable (a natively disabled button gets none of those events). Hovering,
// focusing, or clicking it reveals REQUIRED_MESSAGE; leaving or blurring hides
// it. Nothing shows before that. The wording is generic on purpose, never names
// the missing items, and is the same everywhere.
//
// Revealing the message never moves the button or anything above it (#237).
// It used to mount on reveal, inline before Save in a right-aligned wrapping
// row: hovering Save reflowed the row, Save slid out from under the cursor,
// mouseleave hid the message, Save slid back, and the page jittered forever.
// So MissingRequiredReason is always mounted and always takes its line; only
// its visibility changes. And it goes below the button's row, so even its own
// line cannot push the button.
//
// An inline editor (one value edited in place, saved with Enter or a Save
// button) uses the same gate on its Save button. Enter in the field does not go
// through the button, so the field's Enter handler asks the gate first:
// `if (gate.refuse()) return` (in a <form>, also preventDefault the keydown so
// the browser's implicit submission does not run). A refused Enter reveals the
// message and ties it to the field too (spread gate.fieldProps on it) until the
// value is filled. The hook lives in the component that owns the editor, so
// call gate.reset() whenever the editor opens or closes: the Save button
// unmounts without a leave or blur event, and its state would otherwise carry
// over to the next opening.

/** The one message a blocked submit button reveals. */
export const REQUIRED_MESSAGE = 'Fill in the required items first.'

const MARK_STYLE: CSSProperties = { fontWeight: fontWeight.semibold, color: color.textDanger }

/**
 * The red asterisk. Hidden from assistive tech: aria-required (or
 * requiredName) carries the meaning, so a screen reader does not also read "star".
 */
export function RequiredMarker() {
  return <span aria-hidden="true" style={MARK_STYLE}>*</span>
}

/** A FORM_LABEL label with the required marker after its text. */
export function RequiredLabel({ htmlFor, children, style }: { htmlFor?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <label htmlFor={htmlFor} style={{ ...FORM_LABEL, ...style }}>
      {children} <RequiredMarker />
    </label>
  )
}

/**
 * Accessible name for a required field whose control is a button (e.g. a
 * Picker trigger), which cannot carry aria-required.
 */
export function requiredName(name: string): string {
  return `${name} (required)`
}

// A compact helper-text line. display/flexBasis make it a full line of its
// own wherever it lands; visibility (not mounting) is the only thing a reveal
// changes, so the line's space is reserved from the start.
const REASON_LINE: CSSProperties = { ...HELPER_TEXT, display: 'block', flexBasis: '100%', lineHeight: 1.4, marginTop: 4 }

/**
 * REQUIRED_MESSAGE, on its own line below a gated submit button's row.
 * Spread useRequiredSubmit's reasonProps. Always rendered: hidden, it keeps
 * its space with `visibility: hidden`, is aria-hidden, and has no id (so no
 * aria-describedby can reach it); shown, it takes the id the button and field
 * point at. `style` can adjust spacing or color, never visibility.
 */
export function MissingRequiredReason({ id, show, style }: { id: string; show: boolean; style?: CSSProperties }) {
  return (
    <div
      id={show ? id : undefined}
      aria-hidden={show ? undefined : 'true'}
      style={{ ...REASON_LINE, ...style, visibility: show ? 'visible' : 'hidden' }}
    >
      {REQUIRED_MESSAGE}
    </div>
  )
}

/**
 * Gate for a submit button.
 *
 * - `missingRequired`: true while any required value is missing.
 * - `blocked`: true while the button is disabled for any other reason
 *   (demo lock, a request in flight, ...).
 *
 * `disabled` is true when either holds; use it for the button's disabled look
 * and as the submit handler's own guard (Enter in a field, keyboard shortcuts).
 *
 * `buttonProps(onClick)` returns the button's props:
 * - blocked: native `disabled`, exactly as before; no message ever.
 * - missing a required value (and not blocked): `aria-disabled="true"`, and
 *   `onClick` is never called (a submit button's default action is prevented
 *   too). Hover, focus, or click reveals the message and ties it to the
 *   button with aria-describedby; mouse leave and blur hide it.
 * - neither: an ordinary enabled button that calls `onClick`.
 *
 *   const gate = useRequiredSubmit({ missingRequired: !name.trim(), blocked: saving || demoLocked })
 *   <div style={{ display: 'flex', gap: 8 }}>
 *     <button {...gate.buttonProps(handleSave)} style={actionBtnBlue(gate.disabled)}>Save</button>
 *   </div>
 *   <MissingRequiredReason {...gate.reasonProps} />
 */
export function useRequiredSubmit({ missingRequired, blocked = false }: { missingRequired: boolean; blocked?: boolean }) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // A click or tap that did not focus the button (Safari does not focus
  // buttons on click) still reveals the message, until leave or blur.
  const [pressed, setPressed] = useState(false)
  // An attempt that did not go through the button (Enter in an inline
  // editor's field): reveals the message until the value is filled or reset().
  const [tried, setTried] = useState(false)
  // A natively disabled button may get no leave or blur event, so forget any
  // attempt once the button is blocked: after a submit finishes and the form
  // resets, it starts quiet again.
  if (blocked && (hovered || focused || pressed || tried)) {
    setHovered(false)
    setFocused(false)
    setPressed(false)
    setTried(false)
  }
  // An attempt is spent once the value is filled: clearing it again does not
  // bring the message back unless the button is still hovered or focused.
  if (!missingRequired && (pressed || tried)) {
    setPressed(false)
    setTried(false)
  }
  const quiet = missingRequired && !blocked
  const show = quiet && (hovered || focused || pressed || tried)
  const buttonProps = (onClick?: (e: MouseEvent<HTMLButtonElement>) => void) => ({
    disabled: blocked,
    'aria-disabled': quiet ? ('true' as const) : undefined,
    'aria-describedby': show ? id : undefined,
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      if (missingRequired || blocked) {
        e.preventDefault()
        if (quiet) setPressed(true)
        return
      }
      onClick?.(e)
    },
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => { setHovered(false); setPressed(false) },
    onFocus: () => setFocused(true),
    onBlur: () => { setFocused(false); setPressed(false) },
  })
  /**
   * For a submit path that bypasses the button (Enter in a field): true when
   * the submit must not go ahead. While a required value is missing (and not
   * blocked) it also reveals the message.
   */
  const refuse = (): boolean => {
    if (quiet) setTried(true)
    return missingRequired || blocked
  }
  /** Forget every attempt; call when an inline editor opens or closes. */
  const reset = useCallback(() => {
    setHovered(false)
    setFocused(false)
    setPressed(false)
    setTried(false)
  }, [])
  return {
    disabled: missingRequired || blocked,
    buttonProps,
    refuse,
    reset,
    /** For the field whose Enter was refused: ties the message to it while shown. */
    fieldProps: { 'aria-describedby': show && tried ? id : undefined },
    /** For MissingRequiredReason; it uses the id only while shown. */
    reasonProps: { id, show },
  }
}
