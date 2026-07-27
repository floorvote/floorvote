/**
 * Tier-1 design tokens — the single authored source for primitive style values.
 * Binding decisions (consolidations, scale rationale) live in docs/style-token-decisions.md.
 * All values are plain serializable primitives (string | number) so a CSS-variable
 * file can be generated from this module without any runtime evaluation.
 *
 * Colors are grouped by role: text · brand/accent · surface/background · border.
 * "absorbs" notes record near-duplicate values collapsed into a canonical (Operation 2).
 */

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

export const color = {
  // --- Text ---
  textPrimary:       '#0f172a',
  textSecondary:     '#5e697d', // darkened from #64748b for WCAG AA on gray surfaces
  textMuted:         '#667386', // darkened from #94a3b8 (absorbs #9ca3af) — optimized AA floor
  textSlate:         '#374151', // absorbs #334155
  textSlate500:      '#475569', // medium slate (tooltip text, neutral chip text)
  countChipText:     '#616e82', // count-pill text; tuned to ~4.5:1 (AA floor) on countChipBg
  textSuccess:       '#16a34a', // success green (confirmations; support vote fill)
  textSuccessDark:   '#166534', // green chip text
  textVoteSupport:   '#15803d', // support vote label / cast-pill base
  textDanger:        '#b91c1c', // medium-dark red
  textErrorRed:      '#dc2626', // error text; oppose cast-pill base
  textDangerDark:    '#991b1b', // dark red chip text
  textDeleteRed:     '#ef4444', // delete button; oppose bar fill
  textRedDark:       '#7f1d1d', // darkest red (priority-high text)
  priorityHigh:      '#850028',
  priorityMedium:    '#be2342',
  priorityLow:       '#c27a83',
  textAmberDark:     '#92400e', // amber chip text
  textAmberHearing:  '#b45309', // hearing date label
  textAmberWarning:  '#854d0e', // warning banner text
  textPurpleChip:    '#7e22ce', // purple chip text
  textVioletChip:    '#5b21b6', // violet chip text
  textVioletAdmin:   '#6d28d9', // admin tab active
  textTealSenate:    '#0f766e', // Senate chamber chip text
  textIndigoMe:      '#6366f1', // "ME" self-badge text

  // --- Brand, link & accent (fills / named chrome colors) ---
  linkBlue:          '#2563eb',
  accentBlue:        '#3b82f6',
  accentBlueMuted:   '#93c5fd', // muted blue outline (hover state)
  brandViolet:       '#7c3aed',
  accentAmber:       '#e8a33d', // Honey — brand accent: wordmark "Vote", relevance slider, settings-nav active line
  voteSupport:       '#22c55e', // support vote bar / cast-pill fill
  partyDemBlue:      '#1d4ed8', // Democrat party badge
  billBadgeNavy:     '#1e3a5f', // bill number badge background
  // Keyboard focus ring. Navy on light surfaces; the sidebar overrides
  // --fv-focus-ring to white. Distinct from accentBlue (chip "selected") and
  // accentBlueMuted (chip hover) so a focused chip never reads as selected.
  focusRing:         '#1e3a5f',
  filterBadgeNavy:   '#1e40af', // active-filter count badge background
  roleChipBlue:      '#0369a1', // role chip text
  roleChipXBlue:     '#7dd3fc', // role chip dismiss button
  tagTextBlue:       '#1e4d8c', // tag chip text
  iconCommentPurple: '#8b5cf6', // comment feed event icon
  iconVoteCyan:      '#06b6d4', // vote-milestone feed event icon
  tooltipBg:         '#1e293b', // dark tooltip / popover background

  // --- Surface & background ---
  white:             '#fff',    // absorbs #ffffff, #fafafa
  surfaceSubtle:     '#f8fafc', // neutral hover / surface
  surfaceMuted:      '#f5f8fc', // lightened from #f1f5f9 (absorbs #eef2f7, #f8f8f7) — raises AA floor for text
  countChipBg:       '#ecf0f6', // count-pill fill; midpoint of surfaceMuted and borderDefault
  surfaceTintBlue:   '#f5f9ff', // faint blue tint behind an expanded custom event
  surfaceTintNavy:   '#f4f7fb', // faint navy tint behind an expanded hearing event
  bgLoginPage:       '#f0f4f8', // login full-bleed background
  bgInfo:            '#eff6ff', // absorbs #ebf3ff, #eef2ff — selection / unread / info
  bgDropdownActive:  '#f0f6ff', // dropdown selected/hover row
  bgBlueChip:        '#e0f2fe', // absorbs #dbeafe — blue chip background
  bgRoleChip:        '#dbeafe', // role/user chip fill — one blue-ramp step up from topic tags, to separate the two
  bgSuccess:         '#f0fdf4', // green surface
  bgSuccessChip:     '#dcfce7', // green chip background
  bgSuccessFaint:    '#f8fefa', // vote button resting bg (support)
  bgTeal:            '#f0fdfa', // teal status background
  bgVioletSoft:      '#f5f3ff', // violet status background
  bgVioletChip:      '#ede9fe', // absorbs #f3e8ff — violet chip background
  bgDangerSoft:      '#fff5f5', // absorbs #fef2f2 — pale red
  bgDangerFaint:     '#fffafa', // vote button resting bg (oppose)
  bgRedPriority:     '#fee2e2', // absorbs #ffe4e6 — red priority background
  bgRedDisabled:     '#fca5a5', // disabled red button background
  bgAmberPriority:   '#fef3c7', // absorbs #fef9c3 — amber / amend background
  bgWarnSoft:        '#fffbeb', // amber warning background

  // --- Border ---
  borderDefault:     '#e2e8f0', // absorbs #e8edf2, #e8ecf1
  borderStrong:      '#cbd5e1', // absorbs #d1d5db
  borderGreenChip:   '#bbf7d0',
  borderGreenStrong: '#86efac',
  borderGreenFaint:  '#d6f5e1', // vote button resting border (support)
  borderNeutralFaint:'#edf1f5', // vote button resting border (neutral)
  borderRedChip:     '#fecaca',
  borderRedStrong:   '#f87171',
  borderRedFaint:    '#fde2e2', // vote button resting border (oppose)
  borderVioletSoft:  '#c4b5fd',
  borderPurpleChip:  '#e9d5ff',
  borderAmber:       '#fde68a',
  borderYellow:      '#fde047',
  borderBlueDash:    '#bae6fd', // dashed blue border / disabled role-chip dismiss
  tagBorderBlue:     '#bfdbfe', // tag chip border
} as const

// ---------------------------------------------------------------------------
// Border-radius  (numeric px values; apply via borderRadius in inline styles)
// ---------------------------------------------------------------------------

export const radius = {
  xs:   2,   // absorbs 1, 2
  sm:   4,   // absorbs 3, 4, 5
  md:   6,   // absorbs 6, 7
  lg:   8,   // absorbs 8, 10
  xl:   12,  // absorbs 12, 20
  pill: 999, // absorbs 99, 999
} as const

// ---------------------------------------------------------------------------
// Font-size  (numeric px values; 11 values → 7 tiers per decisions doc)
// ---------------------------------------------------------------------------

export const fontSize = {
  xs:   10, // absorbs 9, 10 — small captions / badges
  sm:   12, // absorbs 11, 12, 13 — body / chrome (13 collapses here)
  base: 14, // absorbs 14, 15 — emphasis body
  lg:   16, // section titles
  xl:   18, // logo wordmark / subheading
  xxl:  20, // page H1 ("Bills", "Feed")
  xxxl: 22, // hero heading (bill title, login)
} as const

// ---------------------------------------------------------------------------
// Font-weight
// ---------------------------------------------------------------------------

export const fontWeight = {
  normal:   400,
  medium:   500,
  semibold: 600,
  bold:     700,
  heavy:    600, // logo wordmark (Login / AuthVerify)
} as const

// ---------------------------------------------------------------------------
// Brand display face — Archivo. Scoped to the identity zone only: the wordmark
// and the primary sidebar nav (Feed / Bills / Calendar). The rest of the UI is
// Inter (set on <body> in web/index.html). Both families load there.
// ---------------------------------------------------------------------------

export const BRAND_FONT = "'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

// ---------------------------------------------------------------------------
// Box-shadow  (elevation scale; collapses 13 near-duplicate shadows → 6 tiers)
// ---------------------------------------------------------------------------

export const shadow = {
  sm:      '0 1px 3px rgba(0,0,0,0.08)',                              // low: cards, inputs, panels
  md:      '0 2px 8px rgba(0,0,0,0.08)',                              // floating: tooltips, popovers, dropdowns
  lg:      '0 8px 40px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)', // overlays: modals, slide-overs
  sidebar: '2px 0 6px rgba(0,0,0,0.06)',                              // directional (sidebar right edge)
} as const
