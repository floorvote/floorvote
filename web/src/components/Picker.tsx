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

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
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
    else if (e.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : Math.min(activeIndex + 1, items.length - 1)
    else nextIndex = activeIndex < 0 ? items.length - 1 : Math.max(activeIndex - 1, 0)
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
}: {
  label: string
  description?: string
  checked: boolean
  indeterminate?: boolean
  onClick: () => void
  control: 'radio' | 'checkbox'
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
  return (
    <label
      ref={ref}
      onMouseEnter={enter}
      onMouseLeave={() => setTip(null)}
      onFocus={enter}
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
