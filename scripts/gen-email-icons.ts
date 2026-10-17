// Rasterize the email icon set to transparent-background PNGs.
//
//   npm run gen:email-icons
//
// Reads the needs from shared/emailIcons.ts (derived from the same icon tables
// the website renders from), validates every glyph is in the web/index.html
// allowlist, then renders each Material Symbols vector (weight 400, outlined —
// matching the website font; `-fill` for filled rows) in its baked fill color
// and writes web/public/email-icons/<file>. Only files in its own
// <glyph>__<hex>[-fill].png pattern are ever deleted (orphans from renamed or
// removed icons); the wordmark images gen:brand-assets writes there stay.
//
// Run whenever a new icon/color enters the email set. The emailIcons drift test
// fails CI if the PNGs and needs disagree.

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMAIL_ICONS_DIR } from '../shared/emailIcons'
import { generateEmailIcons } from './lib/emailIconsGen'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const written = generateEmailIcons(join(ROOT, EMAIL_ICONS_DIR))
for (const file of written) console.log(`  ${file}`)
console.log(`Wrote ${written.length} icon(s) to ${EMAIL_ICONS_DIR}/`)
