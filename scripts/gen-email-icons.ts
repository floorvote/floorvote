// Rasterize the email icon set to transparent-background PNGs.
//
//   npm run gen:email-icons
//
// Reads the needs from shared/emailIcons.ts (derived from the same icon tables
// the website renders from), validates every glyph is in the web/index.html
// allowlist, then renders each Material Symbols vector (weight 400, outlined —
// matching the website font; `-fill` for filled rows) in its baked fill color
// and writes web/public/email-icons/<file>.
//
// Run whenever a new icon/color enters the email set. The emailIcons drift test
// fails CI if the PNGs and needs disagree.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { EMAIL_ICON_NEEDS, parseIconAllowlist, emailIconSrc, EMAIL_ICONS_DIR } from '../shared/emailIcons'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Render at ~3× the 22px tile so glyphs stay crisp on retina mail clients.
const RENDER_WIDTH = 66

function svgPathFor(icon: string, fill: boolean): string {
  const file = `${icon}${fill ? '-fill' : ''}.svg`
  return join(ROOT, 'node_modules/@material-symbols/svg-400/outlined', file)
}

function main() {
  const allowlist = new Set(parseIconAllowlist(readFileSync(join(ROOT, 'web/index.html'), 'utf8')))

  // Render everything first (validating allowlist + source-svg reads). Only once
  // all succeed do we wipe and write — a missing/renamed glyph aborts before we
  // touch the output dir, so we never leave a partial/empty set behind.
  const rendered = EMAIL_ICON_NEEDS.map(need => {
    if (!allowlist.has(need.icon)) {
      throw new Error(`Icon "${need.icon}" is not in the web/index.html allowlist — add it there first.`)
    }
    // Material Symbols paths carry no fill attribute, so injecting one colors the glyph.
    const raw = readFileSync(svgPathFor(need.icon, need.fill), 'utf8')
    const colored = raw.replace(/<path /g, `<path fill="${need.hex}" `)
    const png = new Resvg(colored, { fitTo: { mode: 'width', value: RENDER_WIDTH } }).render().asPng()
    return { file: emailIconSrc(need.icon, need.hex, need.fill), png }
  })

  const outDir = join(ROOT, EMAIL_ICONS_DIR)
  rmSync(outDir, { recursive: true, force: true })  // drop orphans from renamed/removed icons
  mkdirSync(outDir, { recursive: true })
  for (const { file, png } of rendered) {
    writeFileSync(join(outDir, file), png)
    console.log(`  ${file}`)
  }
  console.log(`Wrote ${readdirSync(outDir).length} icon(s) to ${EMAIL_ICONS_DIR}/`)
}

main()
