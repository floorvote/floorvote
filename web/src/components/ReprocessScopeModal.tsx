import { useEffect } from 'react'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'

export type ReprocessScope = 'prioritized' | 'all'

interface Props {
  /** Fully-analyzed (keyword/manual) bill count, for the "all" button. */
  matchedBillsCount: number | null
  /** Subset with a priority set, for the "prioritized" button. */
  prioritizedBillsCount: number | null
  onChoose: (scope: ReprocessScope) => void
  onDismiss: () => void
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function ReprocessScopeModal({ matchedBillsCount, prioritizedBillsCount, onChoose, onDismiss }: Props) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onDismiss])

  const actionBtn = (bg: string): React.CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px',
    borderRadius: radius.md, border: 'none', background: bg, color: color.white,
    cursor: 'pointer', fontSize: fontSize.sm, marginBottom: 10,
  })

  const showPrioritized = (prioritizedBillsCount ?? 0) > 0
  const allCount = matchedBillsCount ?? 0
  const prioritizedCount = prioritizedBillsCount ?? 0

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div style={{
        background: color.white, borderRadius: radius.lg, padding: 24, width: 460, maxWidth: 'calc(100vw - 32px)',
        boxShadow: shadow.lg, position: 'relative',
      }}>
        <div style={{ fontWeight: fontWeight.bold, fontSize: fontSize.base, color: color.textPrimary, marginBottom: 8 }}>
          Instructions saved
        </div>
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, lineHeight: 1.5 }}>
          New bill texts will automatically use the instructions you just saved. Do you want to apply the
          instructions retroactively, to existing bills?
        </div>

        {showPrioritized && (
          <button type="button" style={actionBtn(color.textErrorRed)} onClick={() => onChoose('prioritized')}>
            <strong>Yes, all {plural(prioritizedCount, 'prioritized bill')}</strong>
            <div style={{ marginTop: 2, opacity: 0.85 }}>Bills marked high, medium, or low priority.</div>
          </button>
        )}
        <button type="button" style={actionBtn(color.textErrorRed)} onClick={() => onChoose('all')}>
          <strong>Yes, all {plural(allCount, 'fully analyzed bill')}</strong>
          <div style={{ marginTop: 2, opacity: 0.85 }}>Bills matching keywords or manually added.</div>
        </button>
        <button type="button" style={actionBtn(color.accentBlue)} onClick={onDismiss}>
          <strong>No, just future bill texts</strong>
        </button>
      </div>
    </div>
  )
}
