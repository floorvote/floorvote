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
export function DraftChip() {
  return (
    <span
      style={{
        ...CHIP_BASE,
        background: 'transparent',
        border: `1px dashed ${color.borderStrong}`,
        color: color.textSecondary,
      }}
    >
      Draft
    </span>
  )
}
