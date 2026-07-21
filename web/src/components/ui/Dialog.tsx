import { useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { color, radius, shadow } from '../../styles/tokens'
import { useFocusTrap } from '../../lib/useFocusTrap'

interface DialogProps {
  onClose: () => void
  label?: string
  labelledBy?: string
  initialFocus?: 'first' | 'container' | RefObject<HTMLElement | null>
  cardStyle?: CSSProperties
  dismissOnBackdrop?: boolean
  children: ReactNode
}

export function Dialog({
  onClose, label, labelledBy, initialFocus = 'first', cardStyle, dismissOnBackdrop = true, children,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  useFocusTrap({ active: true, containerRef: cardRef, onEscape: onClose, initialFocus })

  return createPortal(
    <div
      data-testid="dialog-backdrop"
      onClick={(e) => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
               display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={{ background: color.white, borderRadius: radius.lg, boxShadow: shadow.lg,
                 padding: 24, width: 400, maxWidth: 'calc(100vw - 32px)', position: 'relative',
                 outline: 'none', ...cardStyle }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
