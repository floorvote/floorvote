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
//      renders <MissingRequiredReason {...gate.reasonProps} /> beside the button.
//
// The gate is quiet until tried. While a required value is missing the button
// looks disabled and carries aria-disabled, but stays hoverable, focusable, and
// tappable (a natively disabled button gets none of those events). Hovering,
// focusing, or clicking it reveals REQUIRED_MESSAGE; leaving or blurring hides
// it. Nothing shows before that. The wording is generic on purpose, never names
// the missing items, and is the same everywhere.
//
// An inline editor (one value edited in place, saved with Enter or a Save
// button) that refuses a blank value is the other case. It keeps Save enabled
// and, on a blank save, stays open and says why: useBlankValueGuard() supplies
// the field's aria-required/aria-invalid/aria-describedby, and
// <BlankValueMessage {...guard.messageProps} name="..." /> renders
// "* <name> is required" beside the field as an alert, so a screen reader
// announces it the moment the save is refused. The message clears once the
// value is no longer blank, and on cancel or reopen (guard.reset()).

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

/**
 * REQUIRED_MESSAGE, for beside a gated submit button. Renders nothing unless
 * `show`. Spread useRequiredSubmit's reasonProps.
 */
export function MissingRequiredReason({ id, show, style }: { id: string; show: boolean; style?: CSSProperties }) {
  if (!show) return null
  return (
    <div id={id} style={{ ...HELPER_TEXT, ...style }}>
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
 *   <button {...gate.buttonProps(handleSave)} style={actionBtnBlue(gate.disabled)}>Save</button>
 *   <MissingRequiredReason {...gate.reasonProps} />
 */
export function useRequiredSubmit({ missingRequired, blocked = false }: { missingRequired: boolean; blocked?: boolean }) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  // A click or tap that did not focus the button (Safari does not focus
  // buttons on click) still reveals the message, until leave or blur.
  const [pressed, setPressed] = useState(false)
  // A natively disabled button may get no leave or blur event, so forget any
  // attempt once the button is blocked: after a submit finishes and the form
  // resets, it starts quiet again.
  if (blocked && (hovered || focused || pressed)) {
    setHovered(false)
    setFocused(false)
    setPressed(false)
  }
  const quiet = missingRequired && !blocked
  const show = quiet && (hovered || focused || pressed)
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
  return {
    disabled: missingRequired || blocked,
    buttonProps,
    reasonProps: { id, show },
  }
}

/**
 * Guard for an inline editor that refuses a blank value.
 *
 *   const guard = useBlankValueGuard()
 *   // on open or cancel: guard.reset()
 *   // on save:           if (guard.refuse(value)) return
 *   <input {...guard.fieldProps} onChange={e => { setValue(e.target.value); guard.onValue(e.target.value) }} />
 *   <BlankValueMessage {...guard.messageProps} name="Role name" />
 *
 * A field whose control is a button (a Picker trigger), which cannot carry
 * aria-required or aria-invalid, spreads `triggerProps` instead and names
 * itself with requiredName().
 */
export function useBlankValueGuard() {
  const id = useId()
  const [shown, setShown] = useState(false)
  /** On save: true when `value` is blank, showing the message; the caller then saves nothing. */
  const refuse = useCallback((value: string): boolean => {
    const blank = !value.trim()
    setShown(blank)
    return blank
  }, [])
  /** On every change: hides the message once the value is no longer blank. */
  const onValue = useCallback((value: string) => {
    if (value.trim()) setShown(false)
  }, [])
  /** On opening or cancelling the editor. */
  const reset = useCallback(() => setShown(false), [])
  return {
    refuse,
    onValue,
    reset,
    fieldProps: {
      'aria-required': true,
      'aria-invalid': shown || undefined,
      'aria-describedby': shown ? id : undefined,
    },
    triggerProps: { 'aria-describedby': shown ? id : undefined },
    messageProps: { id, show: shown },
  } as const
}

/**
 * Inline "* <name> is required" for an editor that refused a blank save.
 * Renders nothing unless `show`. Spread useBlankValueGuard's messageProps.
 */
export function BlankValueMessage({ id, show, name, style }: { id: string; show: boolean; name: string; style?: CSSProperties }) {
  if (!show) return null
  return (
    <span id={id} role="alert" style={{ ...HELPER_TEXT, ...style }}>
      <RequiredMarker /> {name} is required
    </span>
  )
}
