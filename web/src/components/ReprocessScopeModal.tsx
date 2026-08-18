import { useRef } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { Dialog } from './ui/Dialog'
import { REGENERATE_PRESERVES_DESCRIPTION } from '../lib/billDetailCopy'

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
  // Reprocessing is destructive/consequential, so initial focus must NOT land
  // on either "Yes, reprocess..." button. Focus the cancel-equivalent control
  // ("No, just future bill texts") instead.
  const cancelRef = useRef<HTMLButtonElement>(null)

  const actionBtn = (bg: string): React.CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px',
    borderRadius: radius.md, border: 'none', background: bg, color: color.white,
    cursor: 'pointer', fontSize: fontSize.sm, marginBottom: 10,
  })

  const showPrioritized = (prioritizedBillsCount ?? 0) > 0
  const allCount = matchedBillsCount ?? 0
  const prioritizedCount = prioritizedBillsCount ?? 0

  return (
    <Dialog
      onClose={onDismiss}
      labelledBy="reprocess-scope-title"
      initialFocus={cancelRef}
      cardStyle={{ width: 460 }}
    >
      <div id="reprocess-scope-title" style={{ fontWeight: fontWeight.bold, fontSize: fontSize.base, color: color.textPrimary, marginBottom: 8 }}>
        Instructions saved
      </div>
      <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, lineHeight: 1.5 }}>
        New bill texts will automatically use the instructions you just saved. Do you want to apply the
        instructions retroactively, to existing bills?
      </div>
      <div style={{ fontSize: fontSize.xs, color: color.textSecondary, marginBottom: 12, lineHeight: 1.5 }}>
        {REGENERATE_PRESERVES_DESCRIPTION}
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
      <button ref={cancelRef} type="button" style={actionBtn(color.accentBlue)} onClick={onDismiss}>
        <strong>No, just future bill texts</strong>
      </button>
    </Dialog>
  )
}
