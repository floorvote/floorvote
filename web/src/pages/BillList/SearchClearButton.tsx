import { color, fontSize } from '../../styles/tokens'

// Rendered only when the search box has content: doubles as the "search is
// active" indicator for the scope cluster, the same way a lit pill indicates
// an active toggle.
export function SearchClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button
      onClick={onClear}
      aria-label="Clear search"
      style={{
        position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
        background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
        color: color.textMuted, fontSize: fontSize.base, lineHeight: 1,
        display: 'flex', alignItems: 'center',
      }}
    >×</button>
  )
}
