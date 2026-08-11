import type { MouseEvent } from 'react'
import { apiFetch } from '../lib/api'
import { CompactPrioritySelect } from './CompactPrioritySelect'
import { color, radius, fontSize } from '../styles/tokens'
import { useDemo } from '../context/DemoContext'

interface NewMatchTriageControlProps {
  billId: string
  current: 'high' | 'medium' | 'low' | null
  onChange: (p: 'high' | 'medium' | 'low' | null, result?: { promoted?: boolean }) => void
  onDismiss: () => void
}

/**
 * Triage control for an un-triaged keyword match: the standard priority picker
 * (unchanged — still reads "Not set") joined to a "Dismiss" segment stacked BELOW it
 * under one border (rows have vertical room, not horizontal). Both resolve the match:
 * set a priority, or dismiss ("reviewed — no priority"). Once resolved, the row reverts
 * to the plain CompactPrioritySelect shown everywhere else.
 */
export function NewMatchTriageControl({ billId, current, onChange, onDismiss }: NewMatchTriageControlProps) {
  const { demoLocked } = useDemo()

  function handleDismiss(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (demoLocked) return
    apiFetch(`/bills/${billId}/triage-dismiss`, { method: 'PATCH' }).then(() => onDismiss())
  }

  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column', minWidth: 116,
      border: `1px solid ${color.borderDefault}`, borderRadius: radius.sm, overflow: 'hidden', background: color.white,
    }}>
      <CompactPrioritySelect billId={billId} current={current} onChange={onChange} seamless disabled={demoLocked} />
      <span style={{ height: 1, background: color.borderDefault }} />
      <button
        type="button"
        onClick={handleDismiss}
        onMouseDown={(e) => e.stopPropagation()}
        title="Reviewed — no priority"
        disabled={demoLocked}
        style={{
          border: 'none', background: color.white, textAlign: 'left',
          padding: '4px 10px', whiteSpace: 'nowrap', color: color.textMuted, fontSize: fontSize.sm,
          cursor: demoLocked ? 'not-allowed' : 'pointer',
          opacity: demoLocked ? 0.5 : 1,
        }}
        onMouseEnter={(e) => { if (demoLocked) return; e.currentTarget.style.background = color.surfaceSubtle; e.currentTarget.style.color = color.textSecondary }}
        onMouseLeave={(e) => { if (demoLocked) return; e.currentTarget.style.background = color.white; e.currentTarget.style.color = color.textMuted }}
      >
        ✕ Dismiss
      </button>
    </div>
  )
}
