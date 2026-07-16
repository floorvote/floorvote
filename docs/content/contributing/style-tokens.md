# Style token decisions

`tokens.ts` and all migration must
follow this file. Derived from `docs/style-audit-report.md` plus human review
(perceptual clustering corrected for semantic meaning, and reconciled with the
de-facto scale already established on the bill detail page).

## Guiding rules

- **Tokenize 1:1 by default.** Every distinct raw value that is NOT listed in a
  consolidation below becomes its own token at its exact current value (no
  visual change). Name by role, following existing `chipStyles.ts` conventions.
- **Consolidations below DO change pixels** — they are the approved Operation-2
  collapses. Apply them exactly.
- **Exclude the Tiptap editor palette.** Colors under `web/src/components/tiptap-ui/**`
  that define the user-facing highlight/text-color palette (e.g. `#fcf1f6` and
  its siblings) are product data, not chrome. Do NOT tokenize or alter them, and
  the lint guard must exempt those files.
- **Spacing was not part of this audit pass.** `tokens.ts` may seed a small
  `space` scale for convenience, but migration in this effort targets the three
  audited axes only: color, border-radius, font-size.

## Colors

### A. Clean collapses — true drift, merge to canonical (same role)

| token (suggested) | canonical | absorbs | role |
|---|---|---|---|
| `border.default` | `#e2e8f0` | `#e8edf2`, `#e8ecf1` | default border |
| `text.muted` | `#94a3b8` | `#9ca3af` | muted text |
| `text.slate` | `#374151` | `#334155` | dark slate text |
| `border.strong` | `#cbd5e1` | `#d1d5db` | divider / stronger border |
| `bg.amberPriority` | `#fef3c7` | `#fef9c3` | amber/amend background |
| `bg.redPriority` | `#fee2e2` | `#ffe4e6` | red/priority background |
| `bg.violetChip` | `#ede9fe` | `#f3e8ff` | violet chip background |
| `bg.blueChip` | `#e0f2fe` | `#dbeafe` | blue chip background |

### B. Mixed clusters — re-split by meaning (do NOT flatten to one gray)

The auto-clusterer grouped the following by appearance; keep them distinct by role.

**"white" cluster → two tokens:**
| token | canonical | absorbs |
|---|---|---|
| `white` | `#fff` | `#ffffff`, `#fafafa` |
| `surface.subtle` | `#f8fafc` | *(kept separate — neutral hover/surface, not white)* |

**11-tint "#f1f5f9" cluster → five tokens by hue/meaning:**
| token | canonical | absorbs | meaning |
|---|---|---|---|
| `surface.muted` | `#f1f5f9` | `#eef2f7`, `#f8f8f7` | neutral surface |
| `bg.info` | `#eff6ff` | `#ebf3ff`, `#eef2ff` | selection / unread / info (blue) |
| `bg.success` | `#f0fdf4` | — | success (green) |
| `bg.teal` | `#f0fdfa` | — | teal status |
| `bg.violetSoft` | `#f5f3ff` | — | violet status background |

**"#fff5f5" cluster → split; exclude editor palette:**
| token | canonical | absorbs | meaning |
|---|---|---|---|
| `bg.dangerSoft` | `#fff5f5` | `#fef2f2` | pale red |
| `bg.warnSoft` | `#fffbeb` | — | amber (NOT red — keep separate) |
| *(excluded)* | `#fcf1f6` | — | Tiptap highlight palette — leave untouched |

### C. Everything else
All other distinct colors (e.g. `#0f172a` primary text, `#64748b` secondary text,
`#2563eb`/`#3b82f6` link blue, `#7c3aed` brand violet, the `PRIORITY_COLORS` /
`POSITION_COLORS` foreground values, etc.) tokenize 1:1 at their current value.

## Border-radius — 13 values → 6 tiers

| token | value | absorbs |
|---|---|---|
| `radius.xs` | 2 | 1, 2 |
| `radius.sm` | 4 | 3, 4, 5 |
| `radius.md` | 6 | 6, 7 |
| `radius.lg` | 8 | 8, 10 |
| `radius.xl` | 12 | 12, 20 |
| `radius.pill` | 999 | 99, 999 |

## Font-size — 11 values → 7 tiers (13 dropped → 12)

| token | value | absorbs | role |
|---|---|---|---|
| `fontSize.xs` | 10 | 9, 10 | small captions / badges |
| `fontSize.sm` | 12 | 11, 12, 13 | body / chrome (13 collapses here) |
| `fontSize.base` | 14 | 14, 15 | emphasis body |
| `fontSize.lg` | 16 | 16 | section titles |
| `fontSize.xl` | 18 | 18 | logo wordmark / subheading |
| `fontSize.xxl` | 20 | 20 | page H1 ("Bills", "Pulse") |
| `fontSize.xxxl` | 22 | 22 | hero heading (bill title, login) |

Heading tiers (16/18/20/22) are a real hierarchy and are kept distinct.
Material-symbols icons sized via `fontSize` may reuse these numeric tokens; no
separate icon scale in this pass.

## Font-weight

| token | value | note |
|---|---|---|
| `fontWeight.normal` | 400 | |
| `fontWeight.medium` | 500 | |
| `fontWeight.semibold` | 600 | |
| `fontWeight.bold` | 700 | |
| `fontWeight.heavy` | 800 | logo wordmark (Login/AuthVerify) |
