import { useCallback, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { PopPanel, type PopPanelHandle } from './PopPanel'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'

export interface OverflowMenuRow {
  key: string
  label: string
  description?: string
  onSelect: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
}

interface OverflowMenuProps {
  rows: OverflowMenuRow[]
  triggerStyle?: CSSProperties
}

export function OverflowMenu({ rows, triggerStyle }: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusIndex = useRef(0)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const panelRef = useRef<PopPanelHandle>(null)

  const enabledRows = rows.filter(r => !r.disabled)

  const positionStyle = useCallback((): CSSProperties => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return { position: 'fixed' as const, top: 0, right: 0 }
    return {
      position: 'fixed' as const,
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
      minWidth: 260,
      maxWidth: 340,
    }
  }, [])

  function handleKeyDown(e: React.KeyboardEvent) {
    const len = enabledRows.length
    if (!len) return
    let next = focusIndex.current
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      next = (next + 1) % len
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      next = (next - 1 + len) % len
    } else if (e.key === 'Home') {
      e.preventDefault()
      next = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      next = len - 1
    } else {
      return
    }
    focusIndex.current = next
    const enabledIndex = rows.indexOf(enabledRows[next])
    itemRefs.current[enabledIndex]?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 6px',
          fontSize: fontSize.base,
          color: color.textSecondary,
          borderRadius: radius.sm,
          display: 'flex',
          alignItems: 'center',
          lineHeight: 1,
          letterSpacing: '1px',
          ...triggerStyle,
        }}
      >
        &hellip;
      </button>
      {open && (
        <PopPanel
          ref={panelRef}
          onClose={() => { setOpen(false); triggerRef.current?.focus() }}
          positionStyle={positionStyle()}
          transformOrigin="top right"
          enterOffsetY={-6}
          triggerRef={triggerRef as RefObject<HTMLElement>}
          ariaLabel="Bill actions"
        >
          <div role="menu" tabIndex={-1} onKeyDown={handleKeyDown} style={{ padding: '4px 0' }}>
            {rows.map((row, i) => {
              const isDanger = row.tone === 'danger'
              return (
                <button
                  key={row.key}
                  ref={el => { itemRefs.current[i] = el }}
                  role="menuitem"
                  tabIndex={row.disabled ? -1 : 0}
                  disabled={row.disabled}
                  onClick={() => {
                    if (row.disabled) return
                    panelRef.current?.close()
                    row.onSelect()
                  }}
                  onFocus={() => {
                    const enabledIdx = enabledRows.indexOf(row)
                    if (enabledIdx >= 0) focusIndex.current = enabledIdx
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    padding: '8px 14px',
                    cursor: row.disabled ? 'not-allowed' : 'pointer',
                    opacity: row.disabled ? 0.45 : 1,
                    color: isDanger ? color.textDanger : color.textPrimary,
                    fontSize: fontSize.sm,
                    lineHeight: 1.4,
                  }}
                  onMouseEnter={e => {
                    if (!row.disabled) (e.currentTarget as HTMLElement).style.background = color.surfaceSubtle
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = 'none'
                  }}
                >
                  <div style={{ fontWeight: fontWeight.medium }}>{row.label}</div>
                  {row.description && (
                    <div style={{
                      color: isDanger ? color.textDanger : color.textSecondary,
                      fontSize: fontSize.xs,
                      marginTop: 2,
                      opacity: isDanger ? 0.75 : 1,
                    }}>
                      {row.description}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </PopPanel>
      )}
    </>
  )
}
