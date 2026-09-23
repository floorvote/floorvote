import { CHIP_BASE } from '../lib/chipStyles'
import { color } from '../styles/tokens'

// The word "Draft" for a draft bill — dashed, unfilled, and inert. Pairs with
// the dashed BillBadge outline as the second half of the draft signal, and
// lives in the Status column (empty for every draft, since StatusChip
// returns null for a falsy status) so it costs no extra horizontal space.
//
// Deliberately not a button and not clickable: the Drafts toggle already
// filters on this, and a second click target for the same filter in the same
// row would be worse than one. Render this as plain, non-interactive markup
// — no onClick, no role="button", no hover affordance — anywhere it's used.
//
// The dashed border carries meaning (it's half the draft signal), so it needs
// to clear the WCAG 1.4.11 3:1 non-text-contrast floor, not just look good.
// color.borderStrong is ~1.5:1 on white — too light. textSecondary (~5.9:1,
// already used for this chip's own text) clears it with room to spare; this
// matches the codebase's habit of darkening tokens to clear AA rather than
// picking the lightest value that still reads fine (see shared/tokens.ts).
export function DraftChip({ className }: { className?: string }) {
  return (
    <span
      className={className}
      style={{
        ...CHIP_BASE,
        background: 'transparent',
        border: `1px dashed ${color.textSecondary}`,
        color: color.textSecondary,
      }}
    >
      Draft
    </span>
  )
}
