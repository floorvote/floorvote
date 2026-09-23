import { CHIP_BASE, CHIP_MINI } from '../lib/chipStyles'
import { BODY_FONT, color, fontSize, fontWeight, radius } from '../styles/tokens'

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
//
// `mini` scales it to CHIP_MINI (12px / 2px 6px) so it can sit beside a mini
// BillBadge without dwarfing it — the notifications slide-over's bill footer.
// The sidebar's priority-bill list used to be the other mini caller; it now
// pairs the dashed badge with BillBadge's `draftSrLabel` instead, because the
// priority control shares that badge's line and a second chip on it made an
// already cramped row worse.
export function DraftChip({ mini }: { mini?: boolean } = {}) {
  return (
    <span
      style={{
        ...(mini ? CHIP_MINI : CHIP_BASE),
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
//
// Visibility is owned entirely by the stylesheet (.bill-title-draft-marker in
// mobile.css: hidden by default, revealed in the mid-width band, re-hidden
// below 768px). Do NOT put `display` back into this inline style object —
// inline styles outrank stylesheet rules that aren't !important, so the base
// hide would lose and "Draft" would render at EVERY width, doubling up with
// the Status-column DraftChip at full width. That was a shipped bug; see the
// "owns no display" test in DraftChip.test.tsx.
export function TitleDraftMarker({ className }: { className?: string }) {
  return (
    <span
      className={className}
      style={{
        alignItems: 'center',
        verticalAlign: 'middle',
        // The title line sets 'Source Serif 4', serif; this marker is chip
        // typography and must match the sans chips in the row, so it opts
        // back out to the body/UI face rather than inheriting the serif.
        fontFamily: BODY_FONT,
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
