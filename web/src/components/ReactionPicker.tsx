import { color, radius, fontSize, shadow } from '../styles/tokens'

const EMOJIS = ['❤️', '👍', '👎', '😂', '😭', '💯', '🔥', '🤔']

type Props = {
  onSelect: (emoji: string) => void
}

export function ReactionPicker({ onSelect }: Props) {
  return (
    <div style={{
      display: 'flex',
      gap: 4,
      padding: '6px 8px',
      background: color.white,
      border: `1px solid ${color.borderDefault}`,
      borderRadius: radius.lg,
      boxShadow: shadow.md,
    }}>
      {EMOJIS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onSelect(emoji)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: fontSize.xxl,
            padding: '2px 4px',
            borderRadius: radius.sm,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = color.surfaceMuted }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'none' }}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}
