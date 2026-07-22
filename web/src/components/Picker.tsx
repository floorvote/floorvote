import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { color, radius, fontSize, shadow } from '../styles/tokens'
import { TOOLTIP_STYLE } from '../lib/chipStyles'

export interface PickerOption {
  value: string
  label: string
  /** Optional hover hint shown in a small tooltip above the row. */
  description?: string
}

type SingleProps = {
  mode: 'single'
  value: string | null
  options: PickerOption[]
  onChange: (next: string | null) => void
  trigger: (args: { open: boolean; toggle: () => void }) => ReactNode
  emptyOption?: { label: string }
  align?: 'left' | 'right'
  placement?: 'top' | 'bottom'
  panelMinWidth?: number
  closeOnSelect?: boolean
  /** Accessible name for the option group, e.g. "Priority". Defaults to "Options". */
  ariaLabel?: string
}

type MultiProps = {
  mode: 'multi'
  value: string[]
  options: PickerOption[]
  onChange: (next: string[]) => void
  trigger: (args: { open: boolean; toggle: () => void }) => ReactNode
  indeterminate?: Set<string>
  align?: 'left' | 'right'
  placement?: 'top' | 'bottom'
  panelMinWidth?: number
  /** Accessible name for the option group, e.g. "Tags". Defaults to "Options". */
  ariaLabel?: string
}

export type PickerProps = SingleProps | MultiProps

export function Picker(props: PickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Distinguishes the one synthetic focus() call the open-effect below makes
  // from real user focus (hover, Tab, arrow-key nav) — see Row's onFocus.
  const autoFocusingRef = useRef(false)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Move focus into the menu as soon as it opens, regardless of how it was
  // opened. A mouse click on the trigger leaves focus on the trigger button,
  // so arrow keys never reach handleMenuKeyDown below and instead scroll the
  // surrounding page (R4 bug report: "up/down scroll the bills table rather
  // than select options"). Focusing the selected option (or the first option
  // when nothing is selected) as soon as the panel mounts means arrow-key
  // navigation works immediately no matter how the menu was opened. Guarded
  // to the open transition so it never runs while the panel is closed/unmounted.
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const items = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'))
    if (items.length === 0) return
    const selected = items.find(el => el.checked)
    // Flag this one focus() call as synthetic so Row's onFocus can skip the
    // description-tooltip reveal for it (real hover/Tab/arrow-key focus is
    // unaffected — this ref is false in every other code path). Cleared right
    // after, since React dispatches the resulting onFocus synchronously.
    autoFocusingRef.current = true
    ;(selected ?? items[0]).focus()
    autoFocusingRef.current = false
  }, [open])

  const align = props.align ?? 'left'
  const placement = props.placement ?? 'bottom'
  const minWidth = props.panelMinWidth ?? 180
  const closeOnSelect = props.mode === 'single' && (props.closeOnSelect ?? true)
  const groupLabel = props.ariaLabel ?? 'Options'

  const panelPosition: React.CSSProperties = placement === 'top'
    ? { bottom: 'calc(100% + 4px)' }
    : { top: 'calc(100% + 4px)' }

  // Moves focus back to the trigger element. The trigger is arbitrary
  // (render-prop) markup rendered as a sibling of the panel inside `ref`, so
  // find the first focusable descendant of `ref` that isn't inside the panel.
  function focusTrigger() {
    const root = ref.current
    if (!root) return
    const candidates = root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]',
    )
    for (const el of Array.from(candidates)) {
      if (panelRef.current?.contains(el)) continue
      el.focus()
      return
    }
  }

  function getOptionEls(): HTMLInputElement[] {
    const panel = panelRef.current
    if (!panel) return []
    return Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'))
  }

  function handleMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      focusTrigger()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = getOptionEls()
    if (items.length === 0) return
    const activeIndex = items.indexOf(document.activeElement as HTMLInputElement)
    e.preventDefault()
    let nextIndex: number
    if (e.key === 'Home') nextIndex = 0
    else if (e.key === 'End') nextIndex = items.length - 1
    // Wrap around at the ends, per the WAI-ARIA radiogroup/menu convention (#5 follow-up).
    else if (e.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length
    else nextIndex = activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length
    items[nextIndex].focus()
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      {props.trigger({ open, toggle: () => setOpen(o => !o) })}
      {open && (
        <div
          ref={panelRef}
          role={props.mode === 'single' ? 'radiogroup' : 'group'}
          aria-label={groupLabel}
          onKeyDown={handleMenuKeyDown}
          style={{
            position: 'absolute',
            ...panelPosition,
            [align]: 0,
            zIndex: 400,
            background: color.white,
            border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.lg,
            padding: '4px 0',
            minWidth,
            maxHeight: 300,
            overflowY: 'auto',
            boxShadow: shadow.md,
          }}
        >
          {props.mode === 'single' && props.emptyOption && (
            <Row
              label={props.emptyOption.label}
              checked={props.value === null}
              onClick={() => {
                props.onChange(null)
                if (closeOnSelect) setOpen(false)
              }}
              control="radio"
              autoFocusingRef={autoFocusingRef}
            />
          )}
          {props.options.map(opt => {
            if (props.mode === 'single') {
              const checked = props.value === opt.value
              return (
                <Row
                  key={opt.value}
                  label={opt.label}
                  description={opt.description}
                  checked={checked}
                  onClick={() => {
                    props.onChange(opt.value)
                    if (closeOnSelect) setOpen(false)
                  }}
                  control="radio"
                  autoFocusingRef={autoFocusingRef}
                />
              )
            } else {
              const isIndeterminate = props.indeterminate?.has(opt.value) ?? false
              const checked = !isIndeterminate && props.value.includes(opt.value)
              return (
                <Row
                  key={opt.value}
                  label={opt.label}
                  description={opt.description}
                  checked={checked}
                  indeterminate={isIndeterminate}
                  onClick={() => {
                    if (isIndeterminate || !checked) {
                      props.onChange([...props.value, opt.value])
                    } else {
                      props.onChange(props.value.filter(v => v !== opt.value))
                    }
                  }}
                  autoFocusingRef={autoFocusingRef}
                  control="checkbox"
                />
              )
            }
          })}
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  description,
  checked,
  indeterminate,
  onClick,
  control,
  autoFocusingRef,
}: {
  label: string
  description?: string
  checked: boolean
  indeterminate?: boolean
  onClick: () => void
  control: 'radio' | 'checkbox'
  /** True while Picker's open-effect is making its one synthetic focus() call — see there. */
  autoFocusingRef: React.RefObject<boolean>
}) {
  const ref = useRef<HTMLLabelElement>(null)
  // Tooltip is rendered in a portal with fixed positioning so it escapes the
  // menu's own `overflow: auto` and any clipping ancestor (e.g. a popover).
  const [tip, setTip] = useState<{ right: number; top: number } | null>(null)
  const TIP_MAX = 260
  function enter() {
    const r = ref.current?.getBoundingClientRect()
    // Right-align the bubble to the option's (= dropdown panel's) right edge so it can't
    // extend past the dropdown — keeps it balanced. It grows leftward up to TIP_MAX.
    if (r) setTip({ right: Math.max(8, window.innerWidth - r.right), top: r.top - 6 })
  }
  // Real focus (hover, Tab, arrow-key nav) still reveals the tooltip like
  // before; only the one synthetic auto-focus-on-open call is skipped so
  // opening a Picker doesn't pop a tooltip the user didn't ask for.
  function handleFocus() {
    if (autoFocusingRef.current) return
    enter()
  }
  return (
    <label
      ref={ref}
      onMouseEnter={enter}
      onMouseLeave={() => setTip(null)}
      onFocus={handleFocus}
      onBlur={() => setTip(null)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        cursor: 'pointer',
        fontSize: fontSize.sm,
        color: checked || indeterminate ? color.partyDemBlue : color.textSlate,
        background: checked ? color.bgDropdownActive : 'transparent',
      }}
    >
      <input
        type={control}
        checked={checked}
        readOnly
        onClick={e => {
          e.preventDefault()
          onClick()
        }}
        ref={el => {
          if (el && control === 'checkbox') el.indeterminate = !!indeterminate
        }}
        style={{ margin: 0, accentColor: color.accentBlue, pointerEvents: 'none' }}
      />
      {label}
      {description && tip && createPortal(
        <span
          style={{
            ...TOOLTIP_STYLE,
            position: 'fixed',
            right: tip.right,
            top: tip.top,
            transform: 'translateY(-100%)',
            whiteSpace: 'normal',
            maxWidth: TIP_MAX,
            lineHeight: 1.4,
            textAlign: 'left',
          }}
        >
          {description}
        </span>,
        document.body,
      )}
    </label>
  )
}
