import { color } from './tokens'

// Single source of truth for the views-layer colour, shared by every surface
// that renders it, so they can't drift apart the way this layer already has
// (amber, then a second amber tweak, in two prior commits):
//   web — ViewSwitcher.tsx (trigger label + menu's selected row) and
//         SaveViewButton.tsx ("Save as view" button)
//
// Teal, not the filter blue: this colour means "the views layer," a signal
// distinct from "a filter is on." bgTeal itself reads too pale for a selected
// row, so this uses the chip-strength teal fill/border instead — the same
// relationship bgSuccessChip/bgSuccess has for green.
export const VIEW_STYLE = {
  text: color.textTealSenate,
  bg: color.bgTealChip,
  border: color.borderTealChip,
} as const
