import { CHIP_BASE } from '../lib/chipStyles'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'

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
export function DraftChip() {
  return (
    <span
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

// Compact inline marker for the bill title line — the mid-width fallback used
// only in the band where the Status column (which normally carries DraftChip)
// has been dropped by a @container breakpoint but the mobile stacked row
// hasn't taken over yet (see mobile.css .bill-title-draft-marker). Sized to
// fit inside the title's own line box: total height (line-height + padding +
// border) is 14px, comfortably under the title's 18.9px line box (14px
// fontSize.base * 1.35 line-height), so it can never make the line taller —
// only take horizontal space on it. It still can, on its own, never add
// height; whether it can force an *extra wrapped line* for a very long title
// is a property of that title's text, not of this component, and is measured
// and discussed in BillRow.test.tsx / the task report, not fixable by sizing
// this element differently (any nonzero width inline before wrapped text can
// tip a title sitting exactly at a wrap boundary).
export function TitleDraftMarker({ className }: { className?: string }) {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        verticalAlign: 'middle',
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        lineHeight: '12px',
        padding: '0 6px',
        marginRight: 6,
        borderRadius: radius.sm,
        border: `1px dashed ${color.textSecondary}`,
        color: color.textSecondary,
        background: 'transparent',
      }}
    >
      Draft
    </span>
  )
}
