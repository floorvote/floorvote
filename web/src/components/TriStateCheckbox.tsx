import { color } from '../styles/tokens'
import type { StageCheck } from '../lib/statusGroups'

/**
 * The app's checkbox with a third, mixed state: a native checkbox whose `indeterminate` is set from `state`, the way
 * Picker and the bulk-action menu draw theirs. It also says `aria-checked="mixed"`, which a native indeterminate box
 * leaves implicit. Space toggles it natively, and Enter does too, so it works like the menu's other rows.
 */
export function TriStateCheckbox({ state, onToggle, 'data-stage': dataStage = true }: { state: StageCheck; onToggle: () => void; 'data-stage'?: boolean }) {
  return (
    <input
      type="checkbox"
      data-stage={dataStage ? '' : undefined}
      checked={state === 'on'}
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      ref={el => { if (el) el.indeterminate = state === 'mixed' }}
      onChange={onToggle}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onToggle() } }}
      style={{ margin: 0, accentColor: color.accentBlue, flexShrink: 0 }}
    />
  )
}
